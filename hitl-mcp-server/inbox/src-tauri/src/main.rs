// A release desktop build must not drag a console window behind it. The mobile
// entry point lives in the shared library and never compiles this binary.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hitl_inbox_lib::run();
}
