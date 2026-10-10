fn main() {
    // Release builds bake in the bundled auth server's secret, taken from
    // BETTER_AUTH_SECRET or the repo's .env.
    println!("cargo:rerun-if-env-changed=BETTER_AUTH_SECRET");
    println!("cargo:rerun-if-changed=../../../.env");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let secret = std::env::var("BETTER_AUTH_SECRET").ok().or_else(|| {
            let env = std::fs::read_to_string("../../../.env").ok()?;
            env.lines().find_map(|line| {
                let value = line.trim().strip_prefix("BETTER_AUTH_SECRET=")?.trim();
                Some(value.trim_matches(|c| c == '"' || c == '\'').to_owned())
            })
        });
        match secret {
            Some(secret) if !secret.is_empty() => println!("cargo:rustc-env=SUSH_AUTH_SECRET={secret}"),
            _ => panic!("BETTER_AUTH_SECRET is not set (in the environment or the repo's .env); release builds need it for the auth server"),
        }
    }

    tauri_build::build()
}
