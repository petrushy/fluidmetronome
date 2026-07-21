mod app;
mod audio;
mod file_io;

// The service worker is registered by js/sw-register.js (loaded from
// index.html), which also handles the "new version -- reload" prompt. Keeping
// it out of the WASM means the update UX is plain DOM and there is a single
// registration path.

fn main() {
    yew::Renderer::<app::App>::new().render();
}
