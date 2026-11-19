; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).

; The bundled auth server (sush-auth.exe) can still be running when an update
; starts: the updater exits the app without its usual shutdown, and the server
; only notices a couple of seconds later. Stop it so its file can be replaced.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM sush-auth.exe'
  Pop $0
  Sleep 500
!macroend
