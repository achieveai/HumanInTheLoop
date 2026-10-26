//! Machine-local appearance only; never part of the wire or connection config.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::ErrorKind, path::Path};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Light,
    Dark,
}

fn document(dir: &Path) -> Result<Value, String> {
    let path = dir.join("appearance.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(json!({"version": 1, "theme": "light"}))
        }
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))?;
    if value.get("version") != Some(&json!(1)) {
        return Err(format!(
            "Unsupported appearance version in {}",
            path.display()
        ));
    }
    serde_json::from_value::<Theme>(value["theme"].clone())
        .map_err(|error| format!("Invalid theme in {}: {error}", path.display()))?;
    Ok(value)
}

pub fn load(dir: &Path) -> Result<Theme, String> {
    serde_json::from_value(document(dir)?["theme"].clone()).map_err(|error| error.to_string())
}

pub fn save(dir: &Path, theme: Theme) -> Result<(), String> {
    // Refuse corrupt/unknown documents rather than replacing user data.
    let mut value = document(dir)?;
    value["theme"] = serde_json::to_value(theme).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create appearance directory: {error}"))?;
    let temp = dir.join(format!(".appearance-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&temp, serde_json::to_vec_pretty(&value)?)?;
        fs::rename(&temp, dir.join("appearance.json"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not save appearance: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("hitl-appearance-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn missing_defaults_to_light_without_writing() {
        let dir = TestDir::new();
        assert_eq!(load(&dir.0).unwrap(), Theme::Light);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }
    #[test]
    fn switches_preserve_unknown_fields_and_other_preferences() {
        let dir = TestDir::new();
        fs::write(
            dir.0.join("appearance.json"),
            r#"{"version":1,"theme":"light","future":42}"#,
        )
        .unwrap();
        fs::write(
            dir.0.join("inbox-settings.json"),
            r#"{"notifications":false}"#,
        )
        .unwrap();
        for theme in [Theme::Dark, Theme::Light, Theme::Dark] {
            save(&dir.0, theme).unwrap();
            assert_eq!(load(&dir.0).unwrap(), theme);
            assert_eq!(document(&dir.0).unwrap()["future"], 42);
        }
        assert_eq!(
            fs::read_to_string(dir.0.join("inbox-settings.json")).unwrap(),
            r#"{"notifications":false}"#
        );
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }
    #[test]
    fn invalid_file_is_reported_and_never_overwritten() {
        let dir = TestDir::new();
        for raw in [
            "{",
            r#"{"version":2,"theme":"dark"}"#,
            r#"{"version":1,"theme":"auto"}"#,
        ] {
            fs::write(dir.0.join("appearance.json"), raw).unwrap();
            assert!(load(&dir.0).is_err());
            assert!(save(&dir.0, Theme::Dark).is_err());
            assert_eq!(
                fs::read_to_string(dir.0.join("appearance.json")).unwrap(),
                raw
            );
        }
    }
    #[test]
    fn failed_write_does_not_claim_success() {
        let dir = TestDir::new();
        fs::create_dir(dir.0.join("appearance.json")).unwrap();
        assert!(save(&dir.0, Theme::Dark).is_err());
    }
    #[test]
    fn concurrent_replacements_remain_complete() {
        let dir = TestDir::new();
        save(&dir.0, Theme::Light).unwrap();
        let writers: Vec<_> = (0..4)
            .map(|i| {
                let path = dir.0.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        save(
                            &path,
                            if i % 2 == 0 {
                                Theme::Light
                            } else {
                                Theme::Dark
                            },
                        )
                        .unwrap();
                        load(&path).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        save(&dir.0, Theme::Dark).unwrap();
        assert_eq!(load(&dir.0).unwrap(), Theme::Dark);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
