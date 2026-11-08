import java.lang.classfile.*;
import java.lang.classfile.instruction.*;
import java.lang.constant.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Exact SDK21 call adapters; original game algorithms remain intact. */
public final class PrepareAnimationSdk {
    private static final String ANIM_LAYER = "zombie/core/skinnedmodel/advancedanimation/AnimLayer.class";
    private static final String ACTION_CONTEXT = "zombie/characters/action/ActionContext.class";
    private static final String TILE_OVERLAYS = "zombie/iso/TileOverlays.class";
    private static final String FLUID_CONTAINER = "zombie/entity/components/fluids/FluidContainer.class";
    private static final String LIGHT_SWITCH = "zombie/iso/objects/IsoLightSwitch.class";
    private static final String ITEM_ON_CREATE = "zombie/scripting/logic/ItemCodeOnCreate.class";
    private static final Map<String, Integer> GAMEPLAY_SITES = Map.ofEntries(
            Map.entry("zombie/audio/FMODAmbientWalls.class", 1),
            Map.entry("zombie/audio/SoundInstanceLimiter$SoundInstanceGroup.class", 1),
            Map.entry("zombie/characters/IsoPlayer.class", 1),
            Map.entry("zombie/characters/PlayerCraftHistory.class", 5),
            Map.entry("zombie/characters/Roles.class", 1),
            Map.entry("zombie/characters/ThumpDamageRender.class", 1),
            Map.entry("zombie/characters/animals/IsoAnimal.class", 1),
            Map.entry("zombie/characters/animals/behavior/BaseAnimalBehavior.class", 1),
            Map.entry("zombie/characters/animals/datas/AnimalData.class", 1),
            Map.entry("zombie/core/skinnedmodel/animation/AnimationClip.class", 2),
            Map.entry("zombie/entity/components/crafting/CraftLogic.class", 2),
            Map.entry("zombie/entity/components/crafting/recipe/CraftRecipeListNodeCollection$RecipeNodeComparator.class", 2),
            Map.entry("zombie/iso/ISWorldObjectContextMenuLogic.class", 1),
            Map.entry("zombie/network/packets/ItemTransactionPacket.class", 1),
            Map.entry("zombie/pathfind/PathFindBehavior2.class", 1),
            Map.entry("zombie/randomizedWorld/randomizedBuilding/RBJudge.class", 1),
            Map.entry("zombie/randomizedWorld/randomizedBuilding/RBWoodcraft.class", 1),
            Map.entry("zombie/scripting/logic/RecipeCodeOnCreate.class", 69));
    private static final Map<String, String> EXPECTED = Map.ofEntries(
            Map.entry(ANIM_LAYER, "8b59bfb1ec0c8e7e174cd3ba09042ff3bc9fe82bec38745c73d1f410daca0bc5"),
            Map.entry(ACTION_CONTEXT, "3948dce849e7c6f4ac9522abc0ce802b948b04e341bb3f05d65c3704544690ac"),
            Map.entry(TILE_OVERLAYS, "e1b95c1db4b843b207afe284fbd0f6625403849c4fecefeeed675544662bd49b"),
            Map.entry(FLUID_CONTAINER, "aea1900a815ee2729a5b7c071ead4956e072b4e5ab416eaeaeb5598f00466048"),
            Map.entry(LIGHT_SWITCH, "9267088ed424aee1348c3eae65e50d86811646219330a7230eb1f8e6183e20b5"),
            Map.entry(ITEM_ON_CREATE, "b4f8f17383f202b33b7643c72b2e4ec2803c9542f3fdf824fdc9296c12080d1d"),
            Map.entry("zombie/audio/FMODAmbientWalls.class", "c445fe7d98f7628d51d4e7c6c51b6cc3b526ff30eabab074dac266f47fe66eab"),
            Map.entry("zombie/audio/SoundInstanceLimiter$SoundInstanceGroup.class", "4198eeb69eecca33e197e14192ddac17c27e2b3069e95c8023814e00a7adabdb"),
            Map.entry("zombie/characters/IsoPlayer.class", "fed680d2894b965e9e1e95f6fe3f008a86086c489b892435d1c063846d9316fc"),
            Map.entry("zombie/characters/PlayerCraftHistory.class", "998935475512635d42d7d2d7900b3c5e0837abc7f40e31a4fe7ff36cd4c7cc40"),
            Map.entry("zombie/characters/Roles.class", "5926ef645fb6aa34973d61c44ec3e9ae7ab995871cade451d23ee9835f6c3ebf"),
            Map.entry("zombie/characters/ThumpDamageRender.class", "192a13a750006e027cd6c4c56cefc4f1bdc80b0863482170f6908d6fc7fbb792"),
            Map.entry("zombie/characters/animals/IsoAnimal.class", "021a831b66a656c4fffa29644dc47e3aae402f54b447670157f1ac7f9fbbc0e9"),
            Map.entry("zombie/characters/animals/behavior/BaseAnimalBehavior.class", "385a862786018028bff5ae507970dcfe0d95d78a28d494db012e3e104833780b"),
            Map.entry("zombie/characters/animals/datas/AnimalData.class", "b4f8021d8b55ba6dd3e46c73dabb745c0da0cf65a9d16f49a237d26bb431e63f"),
            Map.entry("zombie/core/skinnedmodel/animation/AnimationClip.class", "887d9d10e3e726f479c4c9b78f93cd89ba7cc57ad5f0719e71e3e4d6acf67e0f"),
            Map.entry("zombie/entity/components/crafting/CraftLogic.class", "12dce467ab09beb559428d5750c19d682a784aa4489a56bd79ba374f61e645c8"),
            Map.entry("zombie/entity/components/crafting/recipe/CraftRecipeListNodeCollection$RecipeNodeComparator.class", "760181553ae5a63c6f051c784084ecd59d6e90af182314c996747c561d4dad51"),
            Map.entry("zombie/iso/ISWorldObjectContextMenuLogic.class", "e40dca7a9abd20575ae3942bbad894708a19c40817b6f1e2b91630a692dab4fc"),
            Map.entry("zombie/network/packets/ItemTransactionPacket.class", "105a24b8880bba373c53f5264ea1e00492306f50a048c2aff701a4eaf50966a8"),
            Map.entry("zombie/pathfind/PathFindBehavior2.class", "ca4feb47041973e589d7196ce9bccf46967f5b04cfb114ae15a8dafbecd491d5"),
            Map.entry("zombie/randomizedWorld/randomizedBuilding/RBJudge.class", "b9b7c75eb395fb7c5075b2a3fa477681f9bfd273f103e9217c1437fd972b3f57"),
            Map.entry("zombie/randomizedWorld/randomizedBuilding/RBWoodcraft.class", "efb5a319db52e68ec7e18235e2e91cd3570967f5423ad1c307536a3f51d89979"),
            Map.entry("zombie/scripting/logic/RecipeCodeOnCreate.class", "4a0763de8ac9719dbd708930da215190d52b3fbafd6d2accbd74a3b81a3a55fa"));

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("INPUT_VIEW OUTPUT_OVERLAY_JAR OUTPUT_MANIFEST");
        Path input = Path.of(args[0]).toRealPath();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        Path manifest = Path.of(args[2]).toAbsolutePath().normalize();
        if (output.equals(manifest)
                || (Files.exists(output) && Files.isSameFile(input, output))
                || (Files.exists(manifest) && Files.isSameFile(input, manifest))
                || (Files.exists(output) && Files.exists(manifest) && Files.isSameFile(output, manifest))) {
            throw new IllegalArgumentException("Input/output alias");
        }
        var classes = new LinkedHashMap<String, byte[]>();
        var records = new ArrayList<String>();
        try (var zip = new ZipFile(input.toFile())) {
            var resolver = ClassHierarchyResolver.ofResourceParsing(desc -> {
                String name = desc.descriptorString().substring(1, desc.descriptorString().length() - 1) + ".class";
                var item = zip.getEntry(name);
                try {
                    return item != null ? zip.getInputStream(item) : ClassLoader.getSystemResourceAsStream(name);
                } catch (Exception failure) { throw new IllegalStateException(failure); }
            }).cached();
            var cf = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(resolver));
            for (String entry : new TreeSet<>(EXPECTED.keySet())) {
                byte[] original;
                var source = zip.getEntry(entry);
                if (source == null) throw new IllegalArgumentException("Missing original class: " + entry);
                try (var stream = zip.getInputStream(source)) { original = stream.readAllBytes(); }
                String before = hash(original);
                if (!before.equals(EXPECTED.get(entry))) {
                    throw new IllegalArgumentException("Unqualified class SHA256: " + entry + " " + before);
                }
                var sites = new ArrayList<String>();
                byte[] adapted = cf.transformClass(cf.parse(original), (builder, element) -> {
                    if (!(element instanceof MethodModel method)) { builder.with(element); return; }
                    int[] bci = {0};
                    builder.transformMethod(method, MethodTransform.transformingCode((code, item) -> {
                        int offset = bci[0];
                        if (item instanceof Instruction instruction) bci[0] += instruction.sizeInBytes();
                        if (!(item instanceof InvokeInstruction call)) { code.with(item); return; }
                        String signature = method.methodName().stringValue() + method.methodType().stringValue();
                        String helper;
                        String methodName;
                        String descriptor;
                        if (entry.equals(ANIM_LAYER) && call.owner().asInternalName().equals("java/util/List")
                                && call.name().equalsString("getFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            boolean qualified = signature.equals("transitionTo(Lzombie/core/skinnedmodel/advancedanimation/AnimState;Z)Z") && offset == 34
                                    || signature.equals("getHighestLiveNode()Lzombie/core/skinnedmodel/advancedanimation/LiveAnimNode;") && offset == 18;
                            if (!qualified) throw new IllegalArgumentException("Unqualified List.getFirst: " + signature + " BCI" + offset);
                            helper = "port.host.ListFirstSupport";
                            methodName = "getFirst";
                            descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                        } else if (entry.equals(ACTION_CONTEXT) && call.owner().asInternalName().equals("java/util/Stack")
                                && call.name().equalsString("removeFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            if (!signature.equals("pushPreviousState(Lzombie/characters/action/ActionState;)V") || offset != 37) {
                                throw new IllegalArgumentException("Unqualified Stack.removeFirst: " + signature + " BCI" + offset);
                            }
                            helper = "port.host.StackFirstSupport";
                            methodName = "removeFirst";
                            descriptor = "(Ljava/util/Stack;)Ljava/lang/Object;";
                        } else if (entry.equals(TILE_OVERLAYS) && call.owner().asInternalName().equals("java/util/ArrayList")
                                && call.name().equalsString("addFirst") && call.type().equalsString("(Ljava/lang/Object;)V")) {
                            if (!signature.equals("updateTileOverlaySprite(Lzombie/iso/IsoObject;)V") || offset != 326) {
                                throw new IllegalArgumentException("Unqualified ArrayList.addFirst: " + signature + " BCI" + offset);
                            }
                            helper = "port.host.ArrayListFirstSupport";
                            methodName = "addFirst";
                            descriptor = "(Ljava/util/ArrayList;Ljava/lang/Object;)V";
                        } else if (entry.equals(FLUID_CONTAINER)
                                && (call.owner().asInternalName().equals("java/util/ArrayList") || call.owner().asInternalName().equals("java/util/List"))
                                && call.name().equalsString("getFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            boolean qualified = signature.equals("readFromScript(Lzombie/scripting/entity/ComponentScript;)V") && offset == 126
                                    || signature.equals("isPureFluid(Lzombie/entity/components/fluids/Fluid;)Z") && offset == 15
                                    || (offset == 24 || offset == 38) && (signature.equals("getPrimaryFluid()Lzombie/entity/components/fluids/Fluid;")
                                        || signature.equals("getPrimaryFluidAmount()F"))
                                    || signature.equals("save(Ljava/nio/ByteBuffer;)V") && offset == 77
                                    || signature.equals("DoTooltip(Lzombie/ui/ObjectTooltip;Lzombie/ui/ObjectTooltip$Layout;)V") && (offset == 81 || offset == 215)
                                    || signature.equals("getUiName()Ljava/lang/String;") && offset == 341;
                            if (!qualified) throw new IllegalArgumentException("Unqualified fluid getFirst: " + signature + " BCI" + offset);
                            helper = "port.host.ListFirstSupport";
                            methodName = "getFirst";
                            descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                        } else if (entry.equals(LIGHT_SWITCH) && call.owner().asInternalName().equals("java/util/ArrayList")
                                && call.name().equalsString("getFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            if (!signature.equals("getPrimaryLight()Lzombie/iso/IsoLightSource;") || offset != 18)
                                throw new IllegalArgumentException("Unqualified light-switch getFirst: " + signature + " BCI" + offset);
                            helper = "port.host.ListFirstSupport";
                            methodName = "getFirst";
                            descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                        } else if (entry.equals(ITEM_ON_CREATE) && call.owner().asInternalName().equals("java/util/List")
                                && call.name().equalsString("getFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            if (!signature.equals("setSchematicLearnedRecipes(Lzombie/inventory/types/Literature;Ljava/util/List;I)V") || offset != 105)
                                throw new IllegalArgumentException("Unqualified schematic getFirst: " + signature + " BCI" + offset);
                            helper = "port.host.ListFirstSupport";
                            methodName = "getFirst";
                            descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                        } else if (GAMEPLAY_SITES.containsKey(entry)
                                && Set.of("java/util/List", "java/util/ArrayList", "java/util/Stack").contains(call.owner().asInternalName())
                                && Set.of("getFirst", "getLast", "removeFirst", "removeLast").contains(call.name().stringValue())
                                && call.type().equalsString("()Ljava/lang/Object;")) {
                            methodName = call.name().stringValue();
                            if (call.owner().asInternalName().equals("java/util/Stack")) {
                                if (!methodName.equals("getFirst")) throw new IllegalArgumentException("Unqualified Stack operation: " + methodName);
                                helper = "port.host.StackFirstSupport";
                                descriptor = "(Ljava/util/Stack;)Ljava/lang/Object;";
                            } else {
                                helper = methodName.equals("removeLast") ? "port.host.PoolListSupport" : "port.host.ListFirstSupport";
                                descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                            }
                        } else { code.with(item); return; }
                        sites.add("{\"method\":\"" + signature + "\",\"originalBCI\":" + offset
                                + ",\"from\":\"" + call.owner().asInternalName() + "." + call.name().stringValue() + call.type().stringValue()
                                + "\",\"to\":\"" + helper + "." + methodName + descriptor + "\"}");
                        code.invokestatic(ClassDesc.of(helper), methodName, MethodTypeDesc.ofDescriptor(descriptor));
                    }));
                });
                int expectedSites = GAMEPLAY_SITES.getOrDefault(entry, entry.equals(ANIM_LAYER) ? 2 : entry.equals(FLUID_CONTAINER) ? 10 : 1);
                if (sites.size() != expectedSites) throw new IllegalArgumentException("Unexpected SDK site count: " + entry + " " + sites.size());
                classes.put(entry, adapted);
                records.add("{\"entry\":\"" + entry + "\",\"inputClassSha256\":\"" + before
                        + "\",\"outputClassSha256\":\"" + hash(adapted) + "\",\"receiver\":\""
                        + (entry.equals(ACTION_CONTEXT) || entry.equals("zombie/characters/IsoPlayer.class")
                            ? "exact java.util.Stack; inherited List default sequence" : "exact java.util.ArrayList; runtime checked")
                        + "\",\"sites\":[" + String.join(",", sites) + "]}");
            }
        }
        try (var jar = new ZipOutputStream(Files.newOutputStream(output))) {
            for (var entry : classes.entrySet()) {
                var item = new ZipEntry(entry.getKey());
                item.setTime(0);
                jar.putNextEntry(item);
                jar.write(entry.getValue());
                jar.closeEntry();
            }
        }
        Files.writeString(manifest, "{\"formatVersion\":2,\"classes\":[" + String.join(",", records)
                + "],\"gameMethodBodyBytesUnchanged\":false,\"originalAlgorithmPreserved\":true}\n");
    }
}
