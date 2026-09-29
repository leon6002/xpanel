// 新界面的构建产物（web/dist）编进程序：它变了就重新编译本 crate
fn main() {
    println!("cargo:rerun-if-changed=../../web/dist");
}
