mod packaged_assets;

fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let output = root.join(".packaged-assets");
    packaged_assets::stage_runtime_assets(&root.join("../src"), &output).expect("stage runtime frontend");
    let mut config: serde_json::Value = std::env::var("TAURI_CONFIG").ok()
        .map(|value| serde_json::from_str(&value).expect("valid TAURI_CONFIG"))
        .unwrap_or_else(|| serde_json::json!({}));
    config["build"]["frontendDist"] = serde_json::json!(".packaged-assets");
    let config = config.to_string();
    std::env::set_var("TAURI_CONFIG", &config);
    println!("cargo:rustc-env=TAURI_CONFIG={config}");
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=packaged_assets.rs");
    tauri_build::build()
}
