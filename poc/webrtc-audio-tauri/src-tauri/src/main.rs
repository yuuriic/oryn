// Em release, sem janela de console no Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Host mínimo: nenhuma API nativa, comando IPC ou plugin. Captura, WebRTC e reprodução
// acontecem inteiramente no WebView2; o objetivo da POC-01B é verificar se isso basta.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("falha ao iniciar a POC-01B");
}
