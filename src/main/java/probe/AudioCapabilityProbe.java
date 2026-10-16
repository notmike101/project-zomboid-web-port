package probe;

/** Browser-only unavailable FMOD recording boundary; never opens a microphone or desktop driver. */
public final class AudioCapabilityProbe {
    public static void main(String[] args) {
        int rejected = 0;
        try { fmod.javafmod.FMOD_System_GetRecordNumDrivers(); throw new AssertionError("FMOD count succeeded"); }
        catch (UnsupportedOperationException expected) {
            if (!expected.getMessage().equals("Browser native capability unavailable: fmod.javafmodJNI.FMOD_System_GetRecordNumDrivers()I"))
                throw new AssertionError("FMOD count diagnostic differs");
            rejected++;
        }
        try { fmod.javafmod.FMOD_System_GetRecordDriverInfo(0, null); throw new AssertionError("FMOD driver query succeeded"); }
        catch (UnsupportedOperationException expected) {
            if (!expected.getMessage().equals("Browser native capability unavailable: fmod.javafmodJNI.FMOD_System_GetRecordDriverInfo(ILfmod/FMOD_DriverInfo;)I"))
                throw new AssertionError("FMOD driver diagnostic differs");
            rejected++;
        }
        if (rejected != 2) throw new AssertionError("FMOD unavailable boundary differs");
        System.out.println("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-audio-capability\",\"cases\":[{\"id\":\"unavailable-recording\",\"outputs\":{\"rejected\":{\"value\":2,\"bits\":\"00000002\"},\"signatures\":{\"value\":2,\"bits\":\"00000002\"}}}],\"pass\":true}");
    }
}
