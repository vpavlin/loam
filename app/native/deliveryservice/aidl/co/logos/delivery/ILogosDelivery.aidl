package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
import co.logos.delivery.IHdCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);
    void unregisterClient(String appId);
    String metrics();   // node peers/mesh as JSON (blind pipe stays blind)
    // MUST stay LAST: AIDL assigns transaction ids by declaration order. Un-rebuilt client apps
    // (kym/qaku/scala/perun) call metrics() at txn id 4 — inserting a method before it shifts metrics()
    // to id 5, so clients hit the wrong method and see "Loam isn't running". New methods go at the end.
    void requestStoreSync(String appId);   // fire-and-forget cold-start history pull; results arrive via callback
    // HD identities (loam-keycard ADR 0001), APPENDED (see above). requestJson =
    // {op:"status"} | {op:"identity", contextId} | {op:"sign", contextId, digestHex}; contextId "" = the main
    // identity. The app namespace is the one recorded when the owner approved the caller, never the request's.
    void hdCall(String appId, String requestJson, IHdCallback cb);
}
