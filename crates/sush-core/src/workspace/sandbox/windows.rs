//! Windows sandbox: a write-restricted token.
//!
//! The command runs with a copy of the user's token made with
//! `WRITE_RESTRICTED`: reads are checked as usual, but every write must also
//! be allowed for one of the token's restricting SIDs. Those are a capability
//! SID derived for Sush ("sushSandboxWrite"), Everyone and the logon session.
//! The workspace folder and Sush's temp folder get an inherited ACE granting
//! that SID full access, and `.git` / `.sush` an ACE denying it writes, so
//! the command can write there and (apart from places writable by Everyone)
//! nowhere else. It runs in a Job Object so Stop kills its whole tree, and it
//! inherits only its own stdio pipes.
//!
//! Network access isn't restricted: that needs firewall rules, which need
//! admin rights.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, SetHandleInformation, ERROR_SUCCESS, GENERIC_ALL, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, ACCESS_MODE, DENY_ACCESS,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, CreateRestrictedToken, DeriveCapabilitySidsFromName, EqualSid, GetAce, GetAclInformation,
    GetLengthSid, GetTokenInformation, SetTokenInformation, TokenDefaultDacl, TokenLogonSid, TokenUser, ACCESS_ALLOWED_ACE,
    ACE_FLAGS, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, NO_INHERITANCE,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_GROUPS,
    TOKEN_INFORMATION_CLASS, TOKEN_QUERY, TOKEN_USER, WRITE_RESTRICTED,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

use super::Policy;
use crate::workspace::shell::{read_capped, report, scrubbed_env, Ending};

/// Name the capability SID is derived from; the same on every machine.
const CAPABILITY: &str = "sushSandboxWrite";
/// Writing data, attributes, deleting, and changing permissions or owner.
const WRITE_RIGHTS: u32 = 0x2 | 0x4 | 0x10 | 0x100 | 0x40 | 0x1_0000 | 0x4_0000 | 0x8_0000;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;

/// Run `command` in PowerShell inside the sandbox, as `shell::run` does outside it.
pub async fn run(cwd: &Path, command: &str, timeout: Duration, cancel: CancellationToken, policy: &Policy) -> Result<String, String> {
    let (child, stdout, stderr) = unsafe { spawn(cwd, command, policy)? };
    let stdout = tokio::spawn(read_capped(Some(tokio::fs::File::from_std(stdout))));
    let stderr = tokio::spawn(read_capped(Some(tokio::fs::File::from_std(stderr))));
    let process = child.process.0 as usize;
    let mut waiter = tokio::task::spawn_blocking(move || unsafe {
        let process = process as HANDLE;
        WaitForSingleObject(process, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(process, &mut code);
        code
    });
    let ending = tokio::select! {
        biased;
        _ = cancel.cancelled() => Ending::Stopped,
        _ = tokio::time::sleep(timeout) => Ending::TimedOut,
        code = &mut waiter => Ending::Exited(Some(code.map_err(|e| e.to_string())? as i32)),
    };
    if !matches!(ending, Ending::Exited(_)) {
        child.terminate();
        let _ = waiter.await;
    }
    drop(child);
    let collect = |h: tokio::task::JoinHandle<String>| async move {
        tokio::time::timeout(Duration::from_secs(2), h).await.ok().and_then(Result::ok).unwrap_or_default()
    };
    report(ending, timeout, collect(stdout).await, collect(stderr).await)
}

/// Let sandboxed commands write in `path`: grant the capability SID full
/// access (inherited), and deny it writes in `.git` and `.sush`. Skipped when
/// the grant is already there, since applying it walks the whole tree.
pub fn grant(path: &Path) -> Result<(), String> {
    let sid = capability_sid()?;
    unsafe {
        if !has_ace(path, sid, ACCESS_ALLOWED_ACE_TYPE)? {
            apply(path, &[explicit(sid.ptr(), FILE_ALL_ACCESS, GRANT_ACCESS, SUB_CONTAINERS_AND_OBJECTS_INHERIT)])?;
        }
        for name in [".git", ".sush"] {
            let protected = path.join(name);
            if protected.is_dir() && !has_ace(&protected, sid, ACCESS_DENIED_ACE_TYPE)? {
                apply(&protected, &[explicit(sid.ptr(), WRITE_RIGHTS, DENY_ACCESS, SUB_CONTAINERS_AND_OBJECTS_INHERIT)])?;
            }
        }
    }
    Ok(())
}

/// Remove what `grant` added.
pub fn revoke(path: &Path) -> Result<(), String> {
    let sid = capability_sid()?;
    unsafe {
        for p in [path.join(".git"), path.join(".sush"), path.to_path_buf()] {
            if p.is_dir() {
                apply(&p, &[explicit(sid.ptr(), 0, REVOKE_ACCESS, NO_INHERITANCE)])?;
            }
        }
    }
    Ok(())
}

// --- handles and SIDs -------------------------------------------------------------------

struct Handle(HANDLE);

// Kernel handles can be used from any thread.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    fn into_raw(self) -> HANDLE {
        let h = self.0;
        std::mem::forget(self);
        h
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// A SID we own, kept 4-byte aligned as SIDs require.
struct Sid(Vec<u32>);

impl Sid {
    fn ptr(&self) -> PSID {
        self.0.as_ptr() as PSID
    }

    unsafe fn copy(sid: PSID) -> Sid {
        let len = GetLengthSid(sid) as usize;
        let mut buf = vec![0u32; len.div_ceil(4)];
        std::ptr::copy_nonoverlapping(sid as *const u8, buf.as_mut_ptr() as *mut u8, len);
        Sid(buf)
    }

    fn parse(s: &str) -> Result<Sid, String> {
        let wide = wide(OsStr::new(s));
        let mut sid: PSID = null_mut();
        unsafe {
            if ConvertStringSidToSidW(wide.as_ptr(), &mut sid) == 0 {
                return Err(last_error("ConvertStringSidToSid"));
            }
            let owned = Sid::copy(sid);
            LocalFree(sid as HLOCAL);
            Ok(owned)
        }
    }
}

fn capability_sid() -> Result<&'static Sid, String> {
    static SID: OnceLock<Result<Sid, String>> = OnceLock::new();
    SID.get_or_init(|| unsafe {
        let name = wide(OsStr::new(CAPABILITY));
        let (mut groups, mut group_count): (*mut PSID, u32) = (null_mut(), 0);
        let (mut caps, mut cap_count): (*mut PSID, u32) = (null_mut(), 0);
        if DeriveCapabilitySidsFromName(name.as_ptr(), &mut groups, &mut group_count, &mut caps, &mut cap_count) == 0 {
            return Err(last_error("DeriveCapabilitySidsFromName"));
        }
        let sid = (cap_count > 0).then(|| Sid::copy(*caps));
        for i in 0..group_count as usize {
            LocalFree(*groups.add(i) as HLOCAL);
        }
        for i in 0..cap_count as usize {
            LocalFree(*caps.add(i) as HLOCAL);
        }
        LocalFree(groups as HLOCAL);
        LocalFree(caps as HLOCAL);
        sid.ok_or_else(|| "Windows returned no capability SID".to_string())
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn last_error(what: &str) -> String {
    format!("{what} failed: {}", std::io::Error::last_os_error())
}

// --- ACLs ----------------------------------------------------------------------------------

fn explicit(sid: PSID, access: u32, mode: ACCESS_MODE, inheritance: ACE_FLAGS) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        },
    }
}

/// Merge `entries` into a file or folder's DACL (children inherit as flagged).
unsafe fn apply(path: &Path, entries: &[EXPLICIT_ACCESS_W]) -> Result<(), String> {
    let name = wide(path.as_os_str());
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let err = GetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        &mut dacl,
        null_mut(),
        &mut descriptor,
    );
    if err != ERROR_SUCCESS {
        return Err(format!("couldn't read the permissions of {}: error {err}", path.display()));
    }
    let mut updated: *mut ACL = null_mut();
    let err = SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), dacl, &mut updated);
    if err != ERROR_SUCCESS {
        LocalFree(descriptor as HLOCAL);
        return Err(format!("couldn't build permissions for {}: error {err}", path.display()));
    }
    let err = SetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        updated,
        null(),
    );
    LocalFree(updated as HLOCAL);
    LocalFree(descriptor as HLOCAL);
    if err != ERROR_SUCCESS {
        return Err(format!("couldn't set the permissions of {}: error {err}", path.display()));
    }
    Ok(())
}

/// Whether the folder's DACL already has an explicit ACE of `ace_type` for
/// `sid` (allowed and denied ACEs share a layout).
unsafe fn has_ace(path: &Path, sid: &Sid, ace_type: u8) -> Result<bool, String> {
    let name = wide(path.as_os_str());
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let err = GetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        &mut dacl,
        null_mut(),
        &mut descriptor,
    );
    if err != ERROR_SUCCESS {
        return Err(format!("couldn't read the permissions of {}: error {err}", path.display()));
    }
    let mut found = false;
    let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
    if !dacl.is_null()
        && GetAclInformation(dacl, &mut info as *mut _ as _, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) != 0
    {
        for i in 0..info.AceCount {
            let mut ace = null_mut();
            if GetAce(dacl, i, &mut ace) == 0 {
                continue;
            }
            let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
            if ace.Header.AceType == ace_type && EqualSid(&ace.SidStart as *const u32 as PSID, sid.ptr()) != 0 {
                found = true;
                break;
            }
        }
    }
    LocalFree(descriptor as HLOCAL);
    Ok(found)
}

// --- the token ---------------------------------------------------------------------------

unsafe fn token_info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>, String> {
    let mut len = 0u32;
    GetTokenInformation(token, class, null_mut(), 0, &mut len);
    if len == 0 {
        return Err(last_error("GetTokenInformation"));
    }
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    if GetTokenInformation(token, class, buf.as_mut_ptr() as _, len, &mut len) == 0 {
        return Err(last_error("GetTokenInformation"));
    }
    Ok(buf)
}

unsafe fn restricted_token() -> Result<Handle, String> {
    let capability = capability_sid()?;
    let mut own: HANDLE = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &mut own) == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    let own = Handle(own);
    let everyone = Sid::parse("S-1-1-0")?;
    let logon = token_info(own.0, TokenLogonSid).ok().and_then(|buf| {
        let groups = &*(buf.as_ptr() as *const TOKEN_GROUPS);
        (groups.GroupCount > 0).then(|| Sid::copy(groups.Groups[0].Sid))
    });
    let mut restrict = vec![
        SID_AND_ATTRIBUTES { Sid: capability.ptr(), Attributes: 0 },
        SID_AND_ATTRIBUTES { Sid: everyone.ptr(), Attributes: 0 },
    ];
    if let Some(logon) = &logon {
        restrict.push(SID_AND_ATTRIBUTES { Sid: logon.ptr(), Attributes: 0 });
    }
    let mut token: HANDLE = null_mut();
    if CreateRestrictedToken(
        own.0,
        DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
        0,
        null(),
        0,
        null(),
        restrict.len() as u32,
        restrict.as_ptr(),
        &mut token,
    ) == 0
    {
        return Err(last_error("CreateRestrictedToken"));
    }
    let token = Handle(token);

    // Objects the command creates without a parent folder (pipes, events)
    // get the default DACL; let the restricting SID write them too.
    let user = token_info(own.0, TokenUser)?;
    let user_sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
    let system = Sid::parse("S-1-5-18")?;
    let entries = [
        explicit(user_sid, GENERIC_ALL, GRANT_ACCESS, NO_INHERITANCE),
        explicit(system.ptr(), GENERIC_ALL, GRANT_ACCESS, NO_INHERITANCE),
        explicit(capability.ptr(), GENERIC_ALL, GRANT_ACCESS, NO_INHERITANCE),
    ];
    let mut acl: *mut ACL = null_mut();
    let err = SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut acl);
    if err != ERROR_SUCCESS {
        return Err(format!("couldn't build the default permissions: error {err}"));
    }
    let dacl = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
    let ok = SetTokenInformation(
        token.0,
        TokenDefaultDacl,
        &dacl as *const _ as _,
        std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
    );
    LocalFree(acl as HLOCAL);
    if ok == 0 {
        return Err(last_error("SetTokenInformation"));
    }
    Ok(token)
}

// --- the process ---------------------------------------------------------------------------

struct Child {
    process: Handle,
    job: Handle,
}

impl Child {
    fn terminate(&self) {
        unsafe { TerminateJobObject(self.job.0, 1) };
    }
}

/// A pipe whose handles start out inheritable.
unsafe fn pipe() -> Result<(Handle, Handle), String> {
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
    if CreatePipe(&mut read, &mut write, &attrs, 0) == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok((Handle(read), Handle(write)))
}

/// PowerShell with the command passed encoded, so nothing needs quoting.
fn command_line(command: &str) -> Vec<u16> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let utf16: Vec<u8> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let line = format!(
        "\"{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}"
    );
    wide(OsStr::new(&line))
}

/// The child's environment: Sush's minus credentials, with temp folders in the sandbox.
fn environment(policy: &Policy) -> Vec<u16> {
    let temp = policy.temp.as_os_str().to_owned();
    let mut vars: Vec<(std::ffi::OsString, std::ffi::OsString)> = scrubbed_env()
        .into_iter()
        .filter(|(k, _)| {
            let k = k.to_string_lossy().to_ascii_uppercase();
            !k.is_empty() && !k.starts_with('=') && k != "TEMP" && k != "TMP"
        })
        .collect();
    vars.push(("TEMP".into(), temp.clone()));
    vars.push(("TMP".into(), temp));
    vars.push(("PSModuleAnalysisCachePath".into(), policy.temp.join("ps-module-cache").into_os_string()));
    vars.push(("POWERSHELL_TELEMETRY_OPTOUT".into(), "1".into()));
    vars.sort_by_key(|(k, _)| k.to_string_lossy().to_ascii_uppercase());
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(k.encode_wide());
        block.push(b'=' as u16);
        block.extend(v.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

unsafe fn spawn(cwd: &Path, command: &str, policy: &Policy) -> Result<(Child, std::fs::File, std::fs::File), String> {
    let token = restricted_token()?;
    let (in_read, in_write) = pipe()?;
    let (out_read, out_write) = pipe()?;
    let (err_read, err_write) = pipe()?;
    // Our ends stay here; closing the stdin writer gives the command an empty stdin.
    for ours in [&in_write, &out_read, &err_read] {
        SetHandleInformation(ours.0, HANDLE_FLAG_INHERIT, 0);
    }
    drop(in_write);

    // Inherit only the three stdio handles, not every inheritable handle Sush has.
    let mut size = 0usize;
    InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
    let mut attr_buf = vec![0u64; size.div_ceil(8) + 1];
    let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let inherit = [in_read.0, out_write.0, err_write.0];
    if UpdateProcThreadAttribute(
        attrs,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        inherit.as_ptr() as _,
        std::mem::size_of_val(&inherit),
        null_mut(),
        null(),
    ) == 0
    {
        DeleteProcThreadAttributeList(attrs);
        return Err(last_error("UpdateProcThreadAttribute"));
    }

    let mut startup: STARTUPINFOEXW = std::mem::zeroed();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = in_read.0;
    startup.StartupInfo.hStdOutput = out_write.0;
    startup.StartupInfo.hStdError = err_write.0;
    startup.lpAttributeList = attrs;

    let mut line = command_line(command);
    let env = environment(policy);
    let dir = wide(cwd.as_os_str());
    let mut info: PROCESS_INFORMATION = std::mem::zeroed();
    let created = CreateProcessAsUserW(
        token.0,
        null(),
        line.as_mut_ptr(),
        null(),
        null(),
        1,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        env.as_ptr() as _,
        dir.as_ptr(),
        &startup.StartupInfo,
        &mut info,
    );
    DeleteProcThreadAttributeList(attrs);
    if created == 0 {
        return Err(last_error("CreateProcessAsUser"));
    }
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);

    // Put it in a job before it runs, so nothing it starts can escape Stop.
    let job = Handle(CreateJobObjectW(null(), null()));
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let in_job = !job.0.is_null()
        && SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) != 0
        && AssignProcessToJobObject(job.0, process.0) != 0;
    if !in_job {
        let error = last_error("AssignProcessToJobObject");
        TerminateProcess(process.0, 1);
        return Err(error);
    }
    ResumeThread(thread.0);
    // The child has its copies now; ours must close so reads end when it exits.
    drop((thread, in_read, out_write, err_write));

    let stdout = std::fs::File::from_raw_handle(out_read.into_raw() as RawHandle);
    let stderr = std::fs::File::from_raw_handle(err_read.into_raw() as RawHandle);
    Ok((Child { process, job }, stdout, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capability_sid_is_stable() {
        let sid = capability_sid().unwrap();
        assert!(unsafe { GetLengthSid(sid.ptr()) } > 8);
    }

    #[test]
    fn commands_are_passed_encoded() {
        let line = String::from_utf16_lossy(&command_line("echo 'it''s'"));
        assert!(line.contains("-EncodedCommand "));
        assert!(!line.contains("it''s"));
    }
}
