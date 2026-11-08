import com.sun.jdi.ArrayReference;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.Field;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
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

public final class JdiCalibration {
    private static ObjectReference invokeObject(ObjectReference target, ThreadReference thread, String name, String signature, List<Value> arguments) throws Exception {
        Method method = target.referenceType().methodsByName(name, signature).get(0);
        return (ObjectReference) target.invokeMethod(thread, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private static Value invokeValue(ObjectReference target, ThreadReference thread, String name, String signature) throws Exception {
        Method method = target.referenceType().methodsByName(name, signature).get(0);
        return target.invokeMethod(thread, method, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private static String arrayJson(ObjectReference array) {
        StringBuilder result = new StringBuilder("[");
        List<Value> values = ((ArrayReference) array).getValues();
        for (int index = 0; index < values.size(); index++) {
            if (index > 0) result.append(',');
            result.append(values.get(index).toString());
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
            EventSet events = vm.eventQueue().remove(15000);
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
            ObjectReference sceneView = (ObjectReference) binding.getValue(binding.referenceType().fieldByName("sceneView"));
            ObjectReference view = invokeObject(sceneView, thread, "getView", "()Lcom/google/android/filament/View;", Collections.emptyList());
            ObjectReference camera = invokeObject(view, thread, "getCamera", "()Lcom/google/android/filament/Camera;", Collections.emptyList());
            ObjectReference projection = invokeObject(camera, thread, "getProjectionMatrix", "([D)[D", Collections.singletonList(null));
            ObjectReference culling = invokeObject(camera, thread, "getCullingProjectionMatrix", "([D)[D", Collections.singletonList(null));
            ObjectReference model = invokeObject(camera, thread, "getModelMatrix", "([D)[D", Collections.singletonList(null));
            ObjectReference colorGrading = invokeObject(view, thread, "getColorGrading", "()Lcom/google/android/filament/ColorGrading;", Collections.emptyList());
            ObjectReference viewport = invokeObject(view, thread, "getViewport", "()Lcom/google/android/filament/Viewport;", Collections.emptyList());
            StringBuilder json = new StringBuilder();
            json.append("{\"projectionColumnMajor\":").append(arrayJson(projection));
            json.append(",\"cullingProjectionColumnMajor\":").append(arrayJson(culling));
            json.append(",\"cameraModelColumnMajor\":").append(arrayJson(model));
            json.append(",\"aperture\":").append(invokeValue(camera, thread, "getAperture", "()F"));
            json.append(",\"shutterSpeedSeconds\":").append(invokeValue(camera, thread, "getShutterSpeed", "()F"));
            json.append(",\"sensitivityIso\":").append(invokeValue(camera, thread, "getSensitivity", "()F"));
            json.append(",\"near\":").append(invokeValue(camera, thread, "getNear", "()F"));
            json.append(",\"cullingFar\":").append(invokeValue(camera, thread, "getCullingFar", "()F"));
            json.append(",\"customColorGradingPresent\":").append(colorGrading != null);
            json.append(",\"colorGradingType\":").append(colorGrading == null ? "null" : "\"" + colorGrading.referenceType().name() + "\"");
            for (String name : new String[]{"left", "bottom", "width", "height"}) {
                Field field = viewport.referenceType().fieldByName(name);
                json.append(",\"viewport").append(Character.toUpperCase(name.charAt(0))).append(name.substring(1)).append("\":").append(viewport.getValue(field));
            }
            json.append("}");
            System.out.println("CALIBRATION_JSON " + json);
            events.resume();
        } finally {
            if (request != null) request.disable();
            vm.resume();
            vm.dispose();
        }
    }
}
