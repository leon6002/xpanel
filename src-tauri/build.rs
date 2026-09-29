use std::path::Path;

fn main() {
    // 界面在 web/dist（npm run build 生成）。只跑 cargo check / test 时还没构建，
    // 放一个占位页，免得 tauri 因为找不到 frontendDist 编译失败；打包时 beforeBuildCommand 会先构建真的界面。
    let dist = Path::new("../web/dist");
    if !dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(dist);
        let _ = std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=\"utf-8\"><title>xpanel</title><meta name=\"xp-placeholder\"><p style=\"font:14px sans-serif;padding:40px\">界面还没构建：在 web/ 里运行 npm install &amp;&amp; npm run build，再重新编译。</p>",
        );
    }
    tauri_build::build()
}
