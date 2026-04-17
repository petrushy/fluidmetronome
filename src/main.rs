mod app;
mod audio;

fn register_service_worker() {
    let Some(window) = web_sys::window() else {
        return;
    };

    let container = window.navigator().service_worker();
    let _ = container.register("/static/sw.js");
}

fn main() {
    register_service_worker();
    yew::Renderer::<app::App>::new().render();
}
