// 发布版在 Windows 上不弹出命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // xpanel --serve <数据文件夹> [端口]：只开网页服务，不开窗口（也可以用 xp serve）
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s == "--serve").unwrap_or(false) {
        let dir = args.get(2).cloned().unwrap_or_else(|| ".".into());
        let port = args.get(3).and_then(|p| p.parse().ok()).unwrap_or(8765);
        xpanel_lib::serve_cli(dir, port);
        return;
    }
    xpanel_lib::run()
}
