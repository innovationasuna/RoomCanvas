import com.sun.jdi.ArrayReference;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;

import java.util.Collections;
import java.util.List;

/**
 * Read-only JDWP probe for the running A0 scene.
 *
 * Suspends once in VrWalkthroughActivity.onSceneFrame(J)V and only calls
 * getters: it reads the loaded FilamentAsset, the Ceiling0 renderable's
 * MaterialInstance double-sided flag, and the scene lights' type, position,
 * intensity, falloff and shadow-caster flag. It never sets a parameter,
 * never rebuilds a material and never writes to the device.
 */
public final class JdiMaterialProbe {
    private static ObjectReference invokeObject(ObjectReference target, ThreadReference thread,
                                                String name, String signature, List<Value> arguments) throws Exception {
        Method method = target.referenceType().methodsByName(name, signature).get(0);
        return (ObjectReference) target.invokeMethod(thread, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private static Value invokeValue(ObjectReference target, ThreadReference thread,
                                     String name, String signature, List<Value> arguments) throws Exception {
        Method method = target.referenceType().methodsByName(name, signature).get(0);
        return target.invokeMethod(thread, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private static Value invokeStatic(ClassType type, ThreadReference thread,
                                      String name, String signature, List<Value> arguments) throws Exception {
        Method method = type.methodsByName(name, signature).get(0);
        return type.invokeMethod(thread, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private static String arrayJson(ObjectReference array) {
        if (array == null) return "null";
        StringBuilder result = new StringBuilder("[");
        List<Value> values = ((ArrayReference) array).getValues();
        for (int index = 0; index < values.size(); index++) {
            if (index > 0) result.append(',');
            result.append(values.get(index).toString());
        }
        return result.append(']').toString();
    }

    private static String quote(String value) {
        if (value == null) return "null";
        return '"' + value.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    private static String enumName(ObjectReference value, ThreadReference thread) throws Exception {
        if (value == null) return "null";
        return quote(invokeValue(value, thread, "name", "()Ljava/lang/String;", Collections.emptyList()).toString());
    }

    private static String channelJson(VirtualMachine vm, ObjectReference manager, ThreadReference thread,
                                      int instance, int channelCount) throws Exception {
        StringBuilder result = new StringBuilder("[");
        for (int channel = 0; channel < channelCount; channel++) {
            if (channel > 0) result.append(',');
            Value enabled = invokeValue(manager, thread, "getLightChannel", "(II)Z",
                    java.util.Arrays.asList(vm.mirrorOf(instance), vm.mirrorOf(channel)));
            result.append(((com.sun.jdi.BooleanValue) enabled).value());
        }
        return result.append(']').toString();
    }


    public static void main(String[] args) throws Exception {
        String port = args.length > 0 ? args[0] : "18700";
        AttachingConnector connector = null;
        for (AttachingConnector candidate : Bootstrap.virtualMachineManager().attachingConnectors()) {
            if (candidate.name().equals("com.sun.jdi.SocketAttach")) {
                connector = candidate;
                break;
            }
        }
        if (connector == null) throw new IllegalStateException("SocketAttach unavailable");
        java.util.Map<String, Connector.Argument> arguments = connector.defaultArguments();
        Connector.Argument hostArgument = arguments.get("hostname");
        if (hostArgument != null) hostArgument.setValue("127.0.0.1");
        arguments.get("port").setValue(port);
        VirtualMachine vm = connector.attach(arguments);
        BreakpointRequest request = null;
        try {
            List<ReferenceType> activityTypes = vm.classesByName("com.hausen3d.arviewer.VrWalkthroughActivity");
            if (activityTypes.isEmpty()) throw new IllegalStateException("Activity class not loaded");
            ReferenceType activityType = activityTypes.get(0);
            Method onSceneFrame = activityType.methodsByName("onSceneFrame", "(J)V").get(0);
            request = vm.eventRequestManager().createBreakpointRequest(onSceneFrame.allLineLocations().get(0));
            request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            request.enable();
            EventSet events = vm.eventQueue().remove(20000);
            if (events == null) throw new IllegalStateException("Timed out waiting for onSceneFrame");
            BreakpointEvent breakpoint = null;
            for (Event event : events) {
                if (event instanceof BreakpointEvent) breakpoint = (BreakpointEvent) event;
            }
            if (breakpoint == null) {
                events.resume();
                throw new IllegalStateException("No onSceneFrame breakpoint");
            }
            ThreadReference thread = breakpoint.thread();
            ObjectReference activity = thread.frame(0).thisObject();
            Field bindingField = activityType.fieldByName("binding");
            ObjectReference binding = (ObjectReference) activity.getValue(bindingField);
            ObjectReference sceneView = (ObjectReference) binding.getValue(
                    binding.referenceType().fieldByName("sceneView"));
            ObjectReference engine = invokeObject(sceneView, thread, "getEngine",
                    "()Lcom/google/android/filament/Engine;", Collections.emptyList());
            ObjectReference scene = invokeObject(sceneView, thread, "getScene",
                    "()Lcom/google/android/filament/Scene;", Collections.emptyList());
            ObjectReference view = invokeObject(sceneView, thread, "getView",
                    "()Lcom/google/android/filament/View;", Collections.emptyList());

            StringBuilder json = new StringBuilder();
            json.append("{\"activity\":\"VrWalkthroughActivity\"");
            json.append(",\"currentExperiment\":");
            Value currentExperiment = activity.getValue(activityType.fieldByName("currentExperiment"));
            json.append(currentExperiment == null ? "null" : enumName((ObjectReference) currentExperiment, thread));
            json.append(",\"quality\":");
            try {
                ObjectReference quality = currentExperiment == null ? null : invokeObject(
                        (ObjectReference) currentExperiment, thread, "getQuality",
                        "()Lcom/hausen3d/arviewer/rendering/RoomRenderQuality;", Collections.emptyList());
                if (quality == null) {
                    json.append("null");
                } else {
                    Value shadowFilter = quality.getValue(quality.referenceType().fieldByName("shadowFilter"));
                    Value shadowsEnabled = quality.getValue(quality.referenceType().fieldByName("shadowsEnabled"));
                    json.append("{\"shadowFilter\":").append(enumName((ObjectReference) shadowFilter, thread));
                    json.append(",\"shadowsEnabled\":").append(
                            ((com.sun.jdi.BooleanValue) shadowsEnabled).value()).append('}');
                }
            } catch (Exception ignored) {
                json.append("null");
            }
            json.append(",\"shadowingEnabled\":");
            try {
                Value shadowingEnabled = invokeValue(view, thread, "isShadowingEnabled", "()Z",
                        Collections.emptyList());
                json.append(((com.sun.jdi.BooleanValue) shadowingEnabled).value());
            } catch (Exception ignored) {
                json.append("null");
            }

            json.append(",\"ambientOcclusionOptions\":");
            try {
                Field aoField = view.referenceType().fieldByName("mAmbientOcclusionOptions");
                ObjectReference ao = (ObjectReference) view.getValue(aoField);
                if (ao == null) {
                    json.append("null");
                } else {
                    ReferenceType aoType = ao.referenceType();
                    json.append("{\"enabled\":").append(
                            ((com.sun.jdi.BooleanValue) ao.getValue(aoType.fieldByName("enabled"))).value());
                    json.append(",\"radius\":").append(ao.getValue(aoType.fieldByName("radius")));
                    json.append(",\"intensity\":").append(ao.getValue(aoType.fieldByName("intensity")));
                    json.append(",\"quality\":").append(enumName(
                            (ObjectReference) ao.getValue(aoType.fieldByName("quality")), thread));
                    json.append(",\"lowPassFilter\":").append(enumName(
                            (ObjectReference) ao.getValue(aoType.fieldByName("lowPassFilter")), thread));
                    json.append(",\"upsampling\":").append(enumName(
                            (ObjectReference) ao.getValue(aoType.fieldByName("upsampling")), thread));
                    json.append('}');
                }
            } catch (Exception ignored) {
                json.append("null");
            }

            Value modelNodeValue = activity.getValue(activityType.fieldByName("modelNode"));
            json.append(",\"modelNodePresent\":").append(modelNodeValue != null);
            if (modelNodeValue != null) {
                ObjectReference modelNode = (ObjectReference) modelNodeValue;
                ObjectReference asset = invokeObject(modelNode, thread, "getModel",
                        "()Lcom/google/android/filament/gltfio/FilamentAsset;", Collections.emptyList());
                json.append(",\"assetPresent\":").append(asset != null);
                if (asset != null) {
                    ObjectReference entities = invokeObject(asset, thread, "getEntities", "()[I", Collections.emptyList());
                    int entityCount = entities == null ? 0 : ((ArrayReference) entities).length();
                    json.append(",\"assetEntityCount\":").append(entityCount);

                    Value entityValue = invokeValue(asset, thread, "getFirstEntityByName",
                            "(Ljava/lang/String;)I",
                            Collections.singletonList(vm.mirrorOf("Ceiling0")));
                    int ceilingEntity = entityValue == null ? -1 : ((com.sun.jdi.IntegerValue) entityValue).value();
                    json.append(",\"ceilingEntityByName\":").append(ceilingEntity);

                    ObjectReference renderableManager = invokeObject(engine, thread, "getRenderableManager",
                            "()Lcom/google/android/filament/RenderableManager;", Collections.emptyList());
                    if (ceilingEntity > 0) {
                        Value hasRenderable = invokeValue(renderableManager, thread, "hasComponent", "(I)Z",
                                Collections.singletonList(vm.mirrorOf(ceilingEntity)));
                        boolean renderable = ((com.sun.jdi.BooleanValue) hasRenderable).value();
                        json.append(",\"ceilingHasRenderable\":").append(renderable);
                        if (renderable) {
                            Value instanceValue = invokeValue(renderableManager, thread, "getInstance", "(I)I",
                                    Collections.singletonList(vm.mirrorOf(ceilingEntity)));
                            int renderableInstance = ((com.sun.jdi.IntegerValue) instanceValue).value();
                            Value primitiveValue = invokeValue(renderableManager, thread, "getPrimitiveCount", "(I)I",
                                    Collections.singletonList(vm.mirrorOf(renderableInstance)));
                            int primitiveCount = ((com.sun.jdi.IntegerValue) primitiveValue).value();
                            json.append(",\"ceilingPrimitiveCount\":").append(primitiveCount);
                            for (int primitive = 0; primitive < primitiveCount; primitive++) {
                                ObjectReference materialInstance = invokeObject(renderableManager, thread,
                                        "getMaterialInstanceAt",
                                        "(II)Lcom/google/android/filament/MaterialInstance;",
                                        java.util.Arrays.asList(vm.mirrorOf(renderableInstance), vm.mirrorOf(primitive)));
                                if (materialInstance == null) continue;
                                ObjectReference material = invokeObject(materialInstance, thread, "getMaterial",
                                        "()Lcom/google/android/filament/Material;", Collections.emptyList());
                                Value instanceDoubleSided = invokeValue(materialInstance, thread, "isDoubleSided",
                                        "()Z", Collections.emptyList());
                                Value materialDoubleSided = invokeValue(material, thread, "isDoubleSided",
                                        "()Z", Collections.emptyList());
                                Value instanceName = invokeValue(materialInstance, thread, "getName",
                                        "()Ljava/lang/String;", Collections.emptyList());
                                Value materialName = invokeValue(material, thread, "getName",
                                        "()Ljava/lang/String;", Collections.emptyList());
                                Value shading = invokeValue(material, thread, "getShading",
                                        "()Lcom/google/android/filament/Material$Shading;", Collections.emptyList());
                                json.append(",\"ceilingMaterialInstance\":{");
                                json.append("\"primitive\":").append(primitive);
                                json.append(",\"instanceName\":").append(quote(instanceName == null ? null : instanceName.toString()));
                                json.append(",\"instanceDoubleSided\":").append(((com.sun.jdi.BooleanValue) instanceDoubleSided).value());
                                json.append(",\"materialName\":").append(quote(materialName == null ? null : materialName.toString()));
                                json.append(",\"materialDoubleSided\":").append(((com.sun.jdi.BooleanValue) materialDoubleSided).value());
                                json.append(",\"shading\":").append(enumName((ObjectReference) shading, thread));
                                json.append("}");
                                break;
                            }
                            Value ceilingShadowCaster = invokeValue(renderableManager, thread, "isShadowCaster", "(I)Z",
                                    Collections.singletonList(vm.mirrorOf(renderableInstance)));
                            Value ceilingShadowReceiver = invokeValue(renderableManager, thread, "isShadowReceiver", "(I)Z",
                                    Collections.singletonList(vm.mirrorOf(renderableInstance)));
                            json.append(",\"ceilingShadowCaster\":").append(((com.sun.jdi.BooleanValue) ceilingShadowCaster).value());
                            json.append(",\"ceilingShadowReceiver\":").append(((com.sun.jdi.BooleanValue) ceilingShadowReceiver).value());
                            json.append(",\"ceilingLightChannels\":").append(
                                    channelJson(vm, renderableManager, thread, renderableInstance, 4));
                        }
                    }
                }
            }

            ObjectReference lightManager = invokeObject(engine, thread, "getLightManager",
                    "()Lcom/google/android/filament/LightManager;", Collections.emptyList());
            ObjectReference sceneEntities = invokeObject(scene, thread, "getEntities", "()[I", Collections.emptyList());
            List<Value> entityValues = ((ArrayReference) sceneEntities).getValues();
            StringBuilder lights = new StringBuilder("[");
            int renderableCount = 0;
            int lightCount = 0;
            ObjectReference renderableManagerForCount = invokeObject(engine, thread, "getRenderableManager",
                    "()Lcom/google/android/filament/RenderableManager;", Collections.emptyList());
            for (Value entityValue : entityValues) {
                int entity = ((com.sun.jdi.IntegerValue) entityValue).value();
                Value hasRenderable = invokeValue(renderableManagerForCount, thread, "hasComponent", "(I)Z",
                        Collections.singletonList(vm.mirrorOf(entity)));
                if (((com.sun.jdi.BooleanValue) hasRenderable).value()) renderableCount++;
                Value hasLight = invokeValue(lightManager, thread, "hasComponent", "(I)Z",
                        Collections.singletonList(vm.mirrorOf(entity)));
                if (!((com.sun.jdi.BooleanValue) hasLight).value()) continue;
                Value lightInstanceValue = invokeValue(lightManager, thread, "getInstance", "(I)I",
                        Collections.singletonList(vm.mirrorOf(entity)));
                int lightInstance = ((com.sun.jdi.IntegerValue) lightInstanceValue).value();
                ObjectReference type = (ObjectReference) invokeValue(lightManager, thread, "getType", "(I)Lcom/google/android/filament/LightManager$Type;",
                        Collections.singletonList(vm.mirrorOf(lightInstance)));
                ObjectReference position = (ObjectReference) invokeValue(lightManager, thread, "getPosition",
                        "(I[F)[F", java.util.Arrays.asList(vm.mirrorOf(lightInstance), null));
                Value intensity = invokeValue(lightManager, thread, "getIntensity", "(I)F",
                        Collections.singletonList(vm.mirrorOf(lightInstance)));
                Value falloff = invokeValue(lightManager, thread, "getFalloff", "(I)F",
                        Collections.singletonList(vm.mirrorOf(lightInstance)));
                Value shadowCaster = invokeValue(lightManager, thread, "isShadowCaster", "(I)Z",
                        Collections.singletonList(vm.mirrorOf(lightInstance)));
                if (lightCount > 0) lights.append(',');
                lights.append("{\"entity\":").append(entity);
                lights.append(",\"type\":").append(enumName(type, thread));
                lights.append(",\"position\":").append(arrayJson(position));
                lights.append(",\"intensity\":").append(intensity);
                lights.append(",\"falloff\":").append(falloff);
                lights.append(",\"shadowCaster\":").append(((com.sun.jdi.BooleanValue) shadowCaster).value());
                lights.append(",\"lightChannels\":").append(channelJson(vm, lightManager, thread, lightInstance, 4));
                lights.append('}');
                lightCount++;
            }
            lights.append(']');
            json.append(",\"sceneEntityCount\":").append(entityValues.size());
            json.append(",\"renderableCount\":").append(renderableCount);
            json.append(",\"lightCount\":").append(lightCount);
            json.append(",\"lights\":").append(lights);
            json.append('}');
            System.out.println("MATERIAL_PROBE_JSON " + json);
            events.resume();
        } finally {
            if (request != null) request.disable();
            vm.resume();
            vm.dispose();
        }
    }
}
