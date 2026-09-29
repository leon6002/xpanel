//! 桌面快捷方式（Windows）

#[cfg(windows)]
pub fn create() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_s = exe.to_string_lossy().to_string();
    let dir_s = exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!(
        "$d=[Environment]::GetFolderPath('Desktop');$l=Join-Path $d 'xpanel.lnk';\
         $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l);$s.TargetPath={exe};\
         $s.WorkingDirectory={dir};$s.IconLocation={icon};$s.Description='xpanel 工作台';$s.Save();Write-Output $l",
        exe = q(&exe_s),
        dir = q(&dir_s),
        icon = q(&format!("{exe_s},0"))
    );
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    use base64::Engine;
    let enc = base64::engine::general_purpose::STANDARD.encode(utf16);
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &enc])
        .creation_flags(0x0800_0000) // 不弹窗口
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "创建快捷方式失败：{}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}
#[cfg(not(windows))]
pub fn create() -> Result<String, String> {
    Err("Mac 上请把「xpanel.app」拖到程序坞".into())
}
