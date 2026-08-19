package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);
    void unregisterClient(String appId);
    void requestStoreSync(String appId);   // fire-and-forget cold-start history pull; results arrive via callback
    String metrics();   // node peers/mesh as JSON (blind pipe stays blind)
}
