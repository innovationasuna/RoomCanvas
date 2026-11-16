import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.util.*;

/** Debug-APK acceptance harness. Mutates only test/monitor state, never lighting/assets/AR poses.
 * Attach/setup happens before the 20-second warmup; the debugger detaches for measurement.
 * Use the identical harness on archived before/after APKs. No Android rebuild is required.
 */
public final class JdiAcceptance {
    static Value call(ObjectReference o, ThreadReference t, String n, String sig, Value... args) throws Exception {
        return o.invokeMethod(t, o.referenceType().methodsByName(n, sig).get(0), Arrays.asList(args), ObjectReference.INVOKE_SINGLE_THREADED);
    }
    static ObjectReference object(ObjectReference o, String n) {
        return (ObjectReference)o.getValue(o.referenceType().fieldByName(n));
    }
    static void set(ObjectReference o, String n, Value v) throws Exception {
        o.setValue(o.referenceType().fieldByName(n), v);
    }
    static String q(String s) { return "\""+s.replace("\\","\\\\").replace("\"","\\\"")+"\""; }
    static String value(Value v) { return v instanceof StringReference ? q(((StringReference)v).value()) : String.valueOf(v); }
    static String entries(ObjectReference activity, ThreadReference thread, VirtualMachine vm) throws Exception {
        ObjectReference articulation=object(activity,"articulation");
        ObjectReference list=object(articulation,"entries");
        int count=((IntegerValue)call(list,thread,"size","()I")).value();
        List<String> rows=new ArrayList<>();
        for(int i=0;i<count;i++) {
            ObjectReference entry=(ObjectReference)call(list,thread,"get","(I)Ljava/lang/Object;",vm.mirrorOf(i));
            List<String> fields=new ArrayList<>();
            for(String name:new String[]{"animationIndex","label","phase","target","moving","open"})
                fields.add(q(name)+":"+value(entry.getValue(entry.referenceType().fieldByName(name))));
            rows.add("{"+String.join(",",fields)+"}");
        }
        return "["+String.join(",",rows)+"]";
    }
    public static void main(String[] args) throws Exception {
        String mode=args[1];
        AttachingConnector connector=Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(c->c.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
        Map<String,Connector.Argument> options=connector.defaultArguments();
        options.get("hostname").setValue("127.0.0.1"); options.get("port").setValue(args[0]);
        VirtualMachine vm=connector.attach(options);
        BreakpointRequest request=null;
        try {
            ReferenceType type=vm.classesByName("com.hausen3d.arviewer.VrWalkthroughActivity").get(0);
            request=vm.eventRequestManager().createBreakpointRequest(type.methodsByName("onSceneFrame","(J)V").get(0).allLineLocations().get(0));
            request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD); request.enable();
            long deadline=System.currentTimeMillis()+20000;
            BreakpointEvent bp=null;
            while(bp==null && System.currentTimeMillis()<deadline) {
                EventSet events=vm.eventQueue().remove(1000);
                if(events==null) continue;
                for(Event event:events) if(event instanceof BreakpointEvent) bp=(BreakpointEvent)event;
                if(bp==null) events.resume();
            }
            if(bp==null) throw new IllegalStateException("No onSceneFrame breakpoint");
            request.disable();
            ThreadReference thread=bp.thread();
            ObjectReference activity=thread.frame(0).thisObject();
            ObjectReference monitor=object(activity,"perfMonitor");
            ObjectReference controller=object(activity,"cameraController");
            if(mode.equals("thermal")) {
                if(!((BooleanValue)activity.getValue(type.fieldByName("debugCameraTrackRunning"))).value())
                    throw new IllegalStateException("Start A0 fixed track before thermal setup");
                ClassType ringType=(ClassType)vm.classesByName("com.hausen3d.arviewer.rendering.FrameTimeRingBuffer").get(0);
                ObjectReference ring=ringType.newInstance(thread,ringType.methodsByName("<init>","(I)V").get(0),List.of(vm.mirrorOf(65536)),ObjectReference.INVOKE_SINGLE_THREADED);
                // JDI rejects final instance fields; use Java reflection on this debug monitor only.
                ObjectReference field=(ObjectReference)call(monitor.referenceType().classObject(),thread,
                    "getDeclaredField","(Ljava/lang/String;)Ljava/lang/reflect/Field;",vm.mirrorOf("sampleFrames"));
                call(field,thread,"setAccessible","(Z)V",vm.mirrorOf(true));
                call(field,thread,"set","(Ljava/lang/Object;Ljava/lang/Object;)V",monitor,ring);
                ClassType system=(ClassType)vm.classesByName("java.lang.System").get(0);
                Value now=system.invokeMethod(thread,system.methodsByName("nanoTime","()J").get(0),List.of(),ObjectReference.INVOKE_SINGLE_THREADED);
                call(object(activity,"debugCameraTrack"),thread,"start","(J)V",now);
                call(monitor,thread,"resetFrameClock","()V");
                call(monitor,thread,"startRun","(Ljava/lang/String;II)V",vm.mirrorOf("A0"),vm.mirrorOf(20),vm.mirrorOf(600));
                if(object(monitor,"sampleFrames").uniqueID()!=ring.uniqueID()
                    || ((IntegerValue)ring.getValue(ringType.fieldByName("capacity"))).value()!=65536
                    || ((IntegerValue)monitor.getValue(monitor.referenceType().fieldByName("sampleDurationSeconds"))).value()!=600)
                    throw new IllegalStateException("Monitor setup readback mismatch");
                System.out.println("ACCEPTANCE_JSON {\"mode\":\"thermal\",\"warmupSeconds\":20,\"sampleSeconds\":600,\"ringCapacity\":65536,\"debuggerDetachesBeforeSampling\":true}");
            } else if(mode.equals("view")) {
                float yaw=Float.parseFloat(args[2]);
                call(controller,thread,"resetToStart","(Ldev/romainguy/kotlin/math/Mat4;J)V",null,vm.mirrorOf(0L));
                call(controller,thread,"applyLookDelta","(FF)V",vm.mirrorOf(-yaw/0.15f),vm.mirrorOf(0f));
                System.out.println("ACCEPTANCE_JSON {\"mode\":\"view\",\"yawDegrees\":"+yaw+",\"entries\":"+entries(activity,thread,vm)+"}");
            } else if(mode.equals("rotation")) {
                int orientation=Integer.parseInt(args[2]);
                call(activity,thread,"setRequestedOrientation","(I)V",vm.mirrorOf(orientation));
                System.out.println("ACCEPTANCE_JSON {\"requestedOrientation\":"+orientation+"}");
            } else if(mode.equals("unfreeze")) {
                set(activity,"debugFreezeArPose",vm.mirrorOf(false));
                ObjectReference controls=object(object(activity,"binding"),"vrTouchControls");
                call(controls,thread,"setInputEnabled","(Z)V",vm.mirrorOf(true));
                System.out.println("ACCEPTANCE_JSON {\"debugFreezeArPose\":false}");
            } else if(mode.equals("inspect")) {
                System.out.println("ACCEPTANCE_JSON {\"entries\":"+entries(activity,thread,vm)+"}");
            } else if(mode.equals("animation")) {
                ObjectReference articulation=object(activity,"articulation");
                Method toggle=articulation.referenceType().allMethods().stream()
                    .filter(m->m.name().startsWith("toggleAnimationForDebug") && m.signature().equals("(I)Z"))
                    .findFirst().orElseThrow();
                Value result=articulation.invokeMethod(thread,toggle,List.of(vm.mirrorOf(Integer.parseInt(args[2]))),ObjectReference.INVOKE_SINGLE_THREADED);
                System.out.println("ACCEPTANCE_JSON {\"route\":\"existing_debug_animation_toggle; not View.pick\",\"accepted\":"+result+"}");
            } else if(mode.equals("monitor")) {
                ObjectReference ring=object(monitor,"sampleFrames");
                System.out.println("ACCEPTANCE_JSON {\"capacity\":"+ring.getValue(ring.referenceType().fieldByName("capacity"))
                    +",\"storedIntervals\":"+ring.getValue(ring.referenceType().fieldByName("size"))
                    +",\"sampleFrameCount\":"+monitor.getValue(monitor.referenceType().fieldByName("sampleFrameCount"))+"}");
            } else if(mode.equals("geometry")) {
                ObjectReference renderer=object(activity,"poseRenderer");
                ObjectReference geometry=(ObjectReference)call(object(renderer,"displayGeometryProvider"),thread,"invoke","()Ljava/lang/Object;");
                List<String> fields=new ArrayList<>();
                fields.add("\"actualDisplayRotation\":"+call(activity,thread,"currentDisplayRotation","()I"));
                for(String name:new String[]{"rotation","width","height"})
                    fields.add(q(name)+":"+geometry.getValue(geometry.referenceType().fieldByName(name)));
                for(String name:new String[]{"surfaceWidth","surfaceHeight","surfaceDepthBits","displayGeometryDirty"})
                    fields.add(q(name)+":"+renderer.getValue(renderer.referenceType().fieldByName(name)));
                System.out.println("ACCEPTANCE_JSON {"+String.join(",",fields)+"}");
            } else throw new IllegalArgumentException("Unknown mode "+mode);
        } finally {
            if(request!=null) request.disable();
            vm.resume(); vm.dispose();
        }
    }
}
