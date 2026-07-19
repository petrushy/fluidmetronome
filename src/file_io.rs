//! Browser download/upload glue for pattern files.

use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, BlobPropertyBag, File, HtmlAnchorElement, Url};

/// Save `contents` to the user's downloads as `filename`.
///
/// There is no browser API for "save this text", so this builds a Blob URL and
/// clicks a synthetic anchor. The object URL is revoked afterwards; without
/// that the blob is retained for the lifetime of the document.
pub fn download_text(filename: &str, contents: &str, mime: &str) -> Result<(), String> {
    let window = web_sys::window().ok_or("No browser window available.")?;
    let document = window.document().ok_or("No document available.")?;

    let parts = js_sys::Array::new();
    parts.push(&JsValue::from_str(contents));

    let options = BlobPropertyBag::new();
    options.set_type(mime);

    let blob = Blob::new_with_str_sequence_and_options(&parts, &options)
        .map_err(|_| "Could not package the file.".to_string())?;
    let url = Url::create_object_url_with_blob(&blob)
        .map_err(|_| "Could not create a download link.".to_string())?;

    let anchor: HtmlAnchorElement = document
        .create_element("a")
        .map_err(|_| "Could not create a download link.".to_string())?
        .dyn_into()
        .map_err(|_| "Could not create a download link.".to_string())?;

    anchor.set_href(&url);
    anchor.set_download(filename);
    anchor.click();

    let _ = Url::revoke_object_url(&url);
    Ok(())
}

/// Read a picked file as text.
pub async fn read_text(file: File) -> Result<String, String> {
    let text = JsFuture::from(file.text())
        .await
        .map_err(|_| "Could not read that file.".to_string())?;

    text.as_string()
        .ok_or_else(|| "That file is not readable as text.".to_string())
}
