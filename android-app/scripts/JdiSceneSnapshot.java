import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.util.*;

/** Host-only, read-only scene snapshot. Getter calls pause one frame; never use during timing. */
public final class JdiSceneSnapshot {
    static Value call(ObjectReference o, ThreadReference t, String n, String sig, Value... args) throws Exception {
        List<Method> methods = o.referenceType().methodsByName(n, sig);
        if (methods.isEmpty()) throw new IllegalStateException("Missing getter " + n + sig);
        return o.invokeMethod(t, methods.get(0), Arrays.asList(args), ObjectReference.INVOKE_SINGLE_THREADED);
    }
    static Value field(ObjectReference o, String n) {
        Field f = o.referenceType().fieldByName(n);
        if (f == null) throw new IllegalStateException("Missing field " + n);
        return o.getValue(f);
    }
    static ObjectReference obj(ObjectReference o, String n) { return (ObjectReference)field(o,n); }
    static String quote(String s) { return "\"" + s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r") + "\""; }
    static String json(Value v) {
        if(v == null) return "null";
        if(v instanceof StringReference) return quote(((StringReference)v).value());
        if(v instanceof ArrayReference) {
            List<String> a = new ArrayList<>();
            for(Value x:((ArrayReference)v).getValues()) a.add(json(x));
            return "["+String.join(",",a)+"]";
        }
        if(v instanceof ObjectReference) {
            ObjectReference o=(ObjectReference)v;
            Field name=o.referenceType().fieldByName("name");
            if(name != null && o.getValue(name) instanceof StringReference) return json(o.getValue(name));
            return quote(o.referenceType().name());
        }
        return v.toString();
    }
    static String fields(ObjectReference o, String... names) {
        List<String> rows=new ArrayList<>();
        for(String n:names) rows.add(quote(n)+":"+json(field(o,n)));
        return "{"+String.join(",",rows)+"}";
    }
    static String snapshot(ObjectReference activity, ThreadReference t, VirtualMachine vm) throws Exception {
        List<String> out=new ArrayList<>();
        out.add("\"activity\":"+fields(activity,"currentExperiment","debugFreezeArPose","debugCameraTrackRunning","started","trackingEnabled","needsReanchor"));
        ObjectReference renderer=obj(activity,"poseRenderer");
        Field storeField=renderer.referenceType().fieldByName("poseStore");
        if(storeField!=null) {
            ObjectReference pose=obj((ObjectReference)renderer.getValue(storeField),"snapshot");
            Value before=field(pose,"timestampNs");
            String poseJson=fields(pose,"isTracking","timestampNs","viewToWorld");
            Value after=field(pose,"timestampNs");
            out.add("\"arPoseStoreSample\":{\"stableTimestampDuringRead\":"+before.equals(after)+",\"sample\":"+poseJson+"}");
        }
        List<String> counters=new ArrayList<>();
        for(String n:new String[]{"poseCounter","frameCounter"}) counters.add(quote(n)+":"+json(call(obj(renderer,n),t,"get","()I")));
        out.add("\"arCounters\":{"+String.join(",",counters)+"}");
        ObjectReference lighting=(ObjectReference)call(activity,t,"getRoomLighting","()Lcom/hausen3d/arviewer/rendering/PhysicalRoomLighting;");
        out.add("\"appliedQuality\":"+fields(obj(lighting,"quality"),"shadowFilter","shadowsEnabled","ssaoEnabled","resolutionScale","sunCascadeCount","sunShadowMapSize","singleWindowShadowOnly","arEnabled"));
        out.add("\"lightSummary\":"+json(field(lighting,"debugLightSummary")));
        ObjectReference controller=obj(activity,"cameraController");
        List<String> controllerRows=new ArrayList<>();
        controllerRows.add("\"state\":"+fields(controller,"startYawDegrees","baseYawDegrees","lookYawDegrees","lookPitchDegrees","heightOffset","appliedArYawDeltaDegrees","arPoseUpdateCount","hasArReference","lastArPoseTimestampNs","lastStepDt"));
        for(String n:new String[]{"startPosition","basePosition","moveOffset","arTranslation"}) controllerRows.add(quote(n)+":"+fields(obj(controller,n),"x","y","z"));
        out.add("\"controller\":{"+String.join(",",controllerRows)+"}");
        ObjectReference sceneView=obj(obj(activity,"binding"),"sceneView");
        ObjectReference view=(ObjectReference)call(sceneView,t,"getView","()Lcom/google/android/filament/View;");
        ObjectReference camera=(ObjectReference)call(view,t,"getCamera","()Lcom/google/android/filament/Camera;");
        List<String> c=new ArrayList<>();
        for(String n:new String[]{"ProjectionMatrix","CullingProjectionMatrix","ModelMatrix"}) c.add(quote(n)+":"+json(call(camera,t,"get"+n,"([D)[D",(Value)null)));
        for(String n:new String[]{"Aperture","ShutterSpeed","Sensitivity","Near","CullingFar"}) c.add(quote(n)+":"+json(call(camera,t,"get"+n,"()F")));
        out.add("\"camera\":{"+String.join(",",c)+"}");
        out.add("\"viewport\":"+fields((ObjectReference)call(view,t,"getViewport","()Lcom/google/android/filament/Viewport;"),"left","bottom","width","height"));
        out.add("\"shadowingEnabledNativeGetter\":"+json(call(view,t,"isShadowingEnabled","()Z")));
        // View options below are Java-side configuration caches, explicitly distinguished from native getters.
        out.add("\"aoJavaOptions\":"+fields(obj(view,"mAmbientOcclusionOptions"),"enabled","radius","intensity","resolution","quality","lowPassFilter","upsampling"));
        out.add("\"dynamicResolutionJavaOptions\":"+fields((ObjectReference)call(view,t,"getDynamicResolutionOptions","()Lcom/google/android/filament/View$DynamicResolutionOptions;"),"enabled","minScale","maxScale","homogeneousScaling","quality"));
        ObjectReference engine=(ObjectReference)call(sceneView,t,"getEngine","()Lcom/google/android/filament/Engine;");
        ObjectReference modelNode=obj(activity,"modelNode");
        ObjectReference asset=(ObjectReference)call(modelNode,t,"getModel","()Lcom/google/android/filament/gltfio/FilamentAsset;");
        Value root=call(asset,t,"getRoot","()I");
        ObjectReference tm=(ObjectReference)call(engine,t,"getTransformManager","()Lcom/google/android/filament/TransformManager;");
        Value rootInstance=call(tm,t,"getInstance","(I)I",root);
        out.add("\"modelRootWorldColumnMajor\":"+json(call(tm,t,"getWorldTransform","(I[F)[F",rootInstance,null)));
        ObjectReference ibl=(ObjectReference)call(sceneView,t,"getIndirectLight","()Lcom/google/android/filament/IndirectLight;");
        out.add("\"iblIntensity\":"+(ibl==null?"null":json(call(ibl,t,"getIntensity","()F"))));
        ObjectReference lm=(ObjectReference)call(engine,t,"getLightManager","()Lcom/google/android/filament/LightManager;");
        ObjectReference lights=obj(lighting,"lightEntities");
        int count=((IntegerValue)call(lights,t,"size","()I")).value();
        List<String> rows=new ArrayList<>();
        for(int i=0;i<count;i++) {
            ObjectReference boxed=(ObjectReference)call(lights,t,"get","(I)Ljava/lang/Object;",vm.mirrorOf(i));
            Value entity=call(boxed,t,"intValue","()I");
            Value instance=call(lm,t,"getInstance","(I)I",entity);
            List<String> l=new ArrayList<>();
            l.add("\"entity\":"+json(entity));
            l.add("\"type\":"+json(call(lm,t,"getType","(I)Lcom/google/android/filament/LightManager$Type;",instance)));
            for(String n:new String[]{"Position","Direction","Color"}) l.add(quote(n)+":"+json(call(lm,t,"get"+n,"(I[F)[F",instance,null)));
            for(String n:new String[]{"Intensity","Falloff"}) l.add(quote(n)+":"+json(call(lm,t,"get"+n,"(I)F",instance)));
            l.add("\"shadowCaster\":"+json(call(lm,t,"isShadowCaster","(I)Z",instance)));
            rows.add("{"+String.join(",",l)+"}");
        }
        out.add("\"lights\":["+String.join(",",rows)+"]");
        ObjectReference articulation=obj(activity,"articulation");
        ObjectReference entries=obj(articulation,"entries");
        count=((IntegerValue)call(entries,t,"size","()I")).value(); rows.clear();
        for(int i=0;i<count;i++) rows.add(fields((ObjectReference)call(entries,t,"get","(I)Ljava/lang/Object;",vm.mirrorOf(i)),"animationIndex","label","duration","openTime","phase","target","moving","open"));
        out.add("\"articulation\":["+String.join(",",rows)+"]");
        return "{"+String.join(",",out)+"}";
    }
    public static void main(String[] args) throws Exception {
        AttachingConnector connector=Bootstrap.virtualMachineManager().attachingConnectors().stream().filter(c->c.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
        Map<String,Connector.Argument> options=connector.defaultArguments();
        options.get("hostname").setValue("127.0.0.1"); options.get("port").setValue(args[0]);
        VirtualMachine vm=connector.attach(options);
        BreakpointRequest request=null;
        try {
            ReferenceType type=vm.classesByName("com.hausen3d.arviewer.VrWalkthroughActivity").get(0);
            request=vm.eventRequestManager().createBreakpointRequest(type.methodsByName("onSceneFrame","(J)V").get(0).allLineLocations().get(0));
            request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD); request.enable();
            long deadline=System.currentTimeMillis()+20000; BreakpointEvent bp=null;
            while(bp==null && System.currentTimeMillis()<deadline) {
                EventSet events=vm.eventQueue().remove(1000);
                if(events==null) continue;
                for(Event e:events) if(e instanceof BreakpointEvent) bp=(BreakpointEvent)e;
                if(bp==null) events.resume();
            }
            if(bp==null) throw new IllegalStateException("No onSceneFrame breakpoint");
            request.disable();
            System.out.println("SCENE_SNAPSHOT_JSON "+snapshot(bp.thread().frame(0).thisObject(),bp.thread(),vm));
        } finally {
            if(request!=null) request.disable();
            vm.resume(); vm.dispose();
        }
    }
}
