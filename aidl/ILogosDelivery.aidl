// The Android IPC boundary for the shared node — the process-crossing form of the
// broker's Tenant API. An app binds to the Logos Delivery service and calls these.
//
// Access is gated by a SIGNATURE-level permission (see the service's manifest):
//   <permission android:name="co.logos.delivery.USE" android:protectionLevel="signature"/>
// so only apps signed by a trusted Logos key may bind — an arbitrary local app cannot
// ride the mesh.
package co.logos.delivery;

import co.logos.delivery.ILogosDeliveryCallback;

interface ILogosDelivery {
    // Register this app and its receive callback. appId scopes the routing table.
    void registerClient(String appId, ILogosDeliveryCallback cb);

    // Topic lifecycle — refcounted inside the broker: the underlying node subscribes
    // on the first app to want a topic and unsubscribes when the last one releases.
    void subscribe(String appId, String contentTopic);
    void unsubscribe(String appId, String contentTopic);

    // SDS reliable channel (ordered, gap-filled) — the path the apps actually use.
    void channelCreate(String appId, String contentTopic, String senderId);
    void channelSend(String appId, String contentTopic, in byte[] payload);

    // Raw content-topic publish (non-channel).
    void send(String appId, String contentTopic, in byte[] payload);

    // History/catch-up. NOTE: results can exceed the ~1MB Binder transaction cap,
    // so this pages — call with an opaque cursor and loop until cursor is null.
    // Returns JSON: { messages: base64[], cursor: String|null }.
    String storeQuery(String appId, String queryJson, String cursor);

    // Prometheus metrics text (shard mesh gauges, peer count) for diagnostics.
    String metrics();

    // Release everything this app owns (unsubscribe its topics, drop its callback).
    void close(String appId);
}
