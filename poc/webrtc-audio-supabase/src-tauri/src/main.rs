// Em release, sem janela de console no Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Host mínimo, o mesmo da POC-01B: nenhuma API nativa, comando IPC ou plugin. A janela carrega o `dist/` do Vite,
// o mesmo bundle publicado na web; toda a lógica do Oryn continua no frontend compartilhado.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o Oryn");
}
