// The service -> app receive path. The broker demuxes the single global node stream
// by content topic and calls only the owning app's callback. An app is handed only
// its own topics' payloads; a foreign app's payload never reaches it (and wouldn't
// decrypt if it did — the app-level AEAD key is the real isolation boundary).
package co.logos.delivery;

interface ILogosDeliveryCallback {
    // oneway: fire-and-forget so a slow app can't block the node's dispatch thread.
    oneway void onMessage(String contentTopic, in byte[] payload);
}
