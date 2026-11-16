// RoomCanvas desktop viewer.
//
// Windows / Filament 1.68.2 reproduction of the Android RoomCanvas scene:
//   - AndroidApp VrWalkthroughActivity.kt  (camera, exposure, model framing)
//   - AndroidApp PhysicalRoomLighting.kt   (IBL, sun, local lights, PCSS, SSAO)
//   - AndroidApp RoomLightLayout.kt        (light placement recipe)
//
// Stage 2 of 《光影渲染性能优化方案2（当前新方案）》.
//
// Presets (mirror the Stage 3 test groups):
//   p1   model + IBL only                  (PC-01)
//   p2   + sun + ceiling/window lights     (PC-02)
//   p3   + PCSS shadows                    (PC-03)
//   p4   + SSAO + Filmic + FXAA = baseline (PC-04)
//
// NOTE: Filament's utils::Path does not convert UTF-8 to wide paths on Windows,
// so every asset path handed to this program must be pure ASCII.

#define SDL_MAIN_HANDLED
#include <SDL.h>
#include <SDL_syswm.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

#include <backend/PixelBufferDescriptor.h>
#include <backend/Platform.h>
#include <backend/platforms/VulkanPlatform.h>

#include <filament/Box.h>
#include <filament/Camera.h>
#include <filament/Color.h>
#include <filament/ColorGrading.h>
#include <filament/Engine.h>
#include <filament/IndirectLight.h>
#include <filament/LightManager.h>
#include <filament/RenderableManager.h>
#include <filament/Renderer.h>
#include <filament/Scene.h>
#include <filament/Skybox.h>
#include <filament/SwapChain.h>
#include <filament/TransformManager.h>
#include <filament/ToneMapper.h>
#include <filament/View.h>
#include <filament/Viewport.h>

#include <filamentapp/IBL.h>
#include <filamentapp/VulkanPlatformHelper.h>

#include <gltfio/AssetLoader.h>
#include <gltfio/FilamentAsset.h>
#include <gltfio/MaterialProvider.h>
#include <gltfio/ResourceLoader.h>
#include <gltfio/TextureProvider.h>
#include <materials/uberarchive.h>

#include <math/mat4.h>
#include <math/vec3.h>
#include <math/vec4.h>

#include <utils/EntityManager.h>
#include <utils/NameComponentManager.h>
#include <utils/Path.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <process.h>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

using namespace filament;
using namespace filament::gltfio;
using namespace filament::math;

namespace {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kEyeHeight = 1.6f;
constexpr float kVerticalFovDeg = 80.0f;
constexpr float kNearPlane = 0.05f;
constexpr float kFarPlane = 100.0f;
constexpr float kEnvironmentIntensity = 0.25f;
constexpr float kSunIntensityLux = 2500.0f;
constexpr float kSunTemperatureK = 6500.0f;
constexpr float kCeilingWatts = 60.0f;
constexpr float kCeilingTemperatureK = 4700.0f;
constexpr float kCeilingDropM = 0.05f;
constexpr float kCeilingBulbRadiusM = 0.05f;
constexpr float kWindowWatts = 20.0f;
constexpr float kWindowTemperatureK = 6500.0f;
constexpr float kWindowInsetM = 0.08f;
constexpr float kWindowBulbRadiusM = 0.20f;
constexpr float kSunElevationDeg = 40.0f;
constexpr float kSunRotationDeg = 35.0f;
constexpr uint32_t kLocalShadowMapSize = 512;
constexpr uint32_t kSunShadowMapSize = 1024;

inline float radians(float degrees) noexcept { return degrees * kPi / 180.0f; }

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

bool startsWith(const std::string& value, const char* prefix) {
    return value.rfind(prefix, 0) == 0;
}

bool containsAny(const std::string& value, std::initializer_list<const char*> needles) {
    for (const char* needle : needles) {
        if (value.find(needle) != std::string::npos) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

struct Preset {
    bool localLights = true;
    bool shadows = true;
    bool ssao = true;
    bool colorGrading = true;
    bool fxaa = true;
};

struct Options {
    std::string modelPath = "D:/FilamentDesktop/assets/room.glb";
    std::string iblPath = "D:/FilamentDesktop/assets/studio_small_09_2k.hdr";
    std::string presetName = "p4";
    std::string backend = "vulkan";
    std::string gpuHint = "NVIDIA";
    std::string csvPath;
    std::string screenshotPath;
    int width = 1280;
    int height = 720;
    float durationSec = 0.0f;
    float warmupSec = 0.0f;
    std::string label = "default";
    std::string frameCsvPath;
    float maxFps = 0.0f;
    float sunLux = kSunIntensityLux;
    bool ignoreSkip = false;
    bool sunShadows = true;
    uint32_t sunMapSize = kSunShadowMapSize;
    std::string shadowType = "pcss";
    bool headless = false;
    bool input = true;
};

Preset resolvePreset(const std::string& name) {
    if (name == "p1") return Preset{false, false, false, false, false};
    if (name == "p2") return Preset{true, false, false, false, false};
    if (name == "p3") return Preset{true, true, false, false, false};
    // Tone-mapped variants for visual comparison (Stage 2 diagnostics).
    if (name == "p1c") return Preset{false, false, false, true, false};
    if (name == "p2c") return Preset{true, false, false, true, false};
    if (name == "p3c") return Preset{true, true, false, true, false};
    return Preset{true, true, true, true, true};
}

void printUsage() {
    std::printf(
            "room_viewer - RoomCanvas Filament desktop reproduction\n"
            "\n"
            "Usage:\n"
            "  room_viewer [options] [model.glb]\n"
            "\n"
            "Options:\n"
            "  --ibl=<path.hdr>       HDR environment (default: studio_small_09_2k.hdr)\n"
            "  --preset=p1|p2|p3|p4   Feature level (default: p4)\n"
            "  --api=vulkan|opengl    Backend (default: vulkan)\n"
            "  --gpu-hint=<substr>    Vulkan device hint (default: NVIDIA)\n"
            "  --width=<px>           Window width (default: 1280)\n"
            "  --height=<px>          Window height (default: 720)\n"
            "  --duration=<seconds>   Stop after N seconds (default: run until quit)\n"
            "  --warmup=<seconds>     Exclude the first N seconds from statistics\n"
            "  --max-fps=<n>          Pace the loop at N frames/second (0 = unthrottled)\n"
            "  --label=<text>         Tag the summary/per-frame CSV rows\n"
            "  --csv=<path>           Append one summary row to a CSV file\n"
            "  --frame-csv=<path>     Write per-frame timing rows to a CSV file\n"
            "  --screenshot=<path>    Write one PNG frame after warm-up\n"
            "  --sun-lux=<lux>        Sun intensity override (diagnostics)\n"
            "  --no-sun-shadow        Disable the sun's shadow map (diagnostics)\n"
            "  --sun-map=<px>         Sun shadow map size (default: 1024)\n"
            "  --shadow-type=pcss|dpcf|pcf\n"
            "  --headless             Hidden window + headless swapchain\n"
            "  --ignore-skip          Render even when beginFrame() asks to skip\n"
            "  --no-input             Disable mouse/keyboard camera control\n"
            "  --help                 Print this message\n");
}

bool parseOptions(int argc, char** argv, Options* out) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&arg](const char* key) -> std::string {
            const std::string prefix = std::string(key) + "=";
            return arg.rfind(prefix, 0) == 0 ? arg.substr(prefix.size()) : std::string();
        };
        if (arg == "--help" || arg == "-h") {
            printUsage();
            return false;
        } else if (arg == "--headless") {
            out->headless = true;
        } else if (arg == "--no-input") {
            out->input = false;
        } else if (arg == "--ignore-skip") {
            out->ignoreSkip = true;
        } else if (arg.rfind("--ibl=", 0) == 0) {
            out->iblPath = value("--ibl");
        } else if (arg.rfind("--preset=", 0) == 0) {
            out->presetName = value("--preset");
        } else if (arg.rfind("--api=", 0) == 0) {
            out->backend = value("--api");
        } else if (arg.rfind("--gpu-hint=", 0) == 0) {
            out->gpuHint = value("--gpu-hint");
        } else if (arg.rfind("--width=", 0) == 0) {
            out->width = std::atoi(value("--width").c_str());
        } else if (arg.rfind("--height=", 0) == 0) {
            out->height = std::atoi(value("--height").c_str());
        } else if (arg.rfind("--duration=", 0) == 0) {
            out->durationSec = std::strtof(value("--duration").c_str(), nullptr);
        } else if (arg.rfind("--warmup=", 0) == 0) {
            out->warmupSec = std::strtof(value("--warmup").c_str(), nullptr);
        } else if (arg.rfind("--max-fps=", 0) == 0) {
            out->maxFps = std::strtof(value("--max-fps").c_str(), nullptr);
        } else if (arg.rfind("--label=", 0) == 0) {
            out->label = value("--label");
        } else if (arg.rfind("--csv=", 0) == 0) {
            out->csvPath = value("--csv");
        } else if (arg.rfind("--frame-csv=", 0) == 0) {
            out->frameCsvPath = value("--frame-csv");
        } else if (arg.rfind("--screenshot=", 0) == 0) {
            out->screenshotPath = value("--screenshot");
        } else if (arg.rfind("--sun-lux=", 0) == 0) {
            out->sunLux = std::strtof(value("--sun-lux").c_str(), nullptr);
        } else if (arg == "--no-sun-shadow") {
            out->sunShadows = false;
        } else if (arg.rfind("--sun-map=", 0) == 0) {
            out->sunMapSize = static_cast<uint32_t>(
                    std::atoi(value("--sun-map").c_str()));
        } else if (arg.rfind("--shadow-type=", 0) == 0) {
            out->shadowType = value("--shadow-type");
        } else if (!arg.empty() && arg[0] != '-') {
            out->modelPath = arg;
        } else {
            std::fprintf(stderr, "Unknown option: %s\n", arg.c_str());
            printUsage();
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Bounds helpers
// ---------------------------------------------------------------------------

struct NamedBounds {
    std::string name;
    Box box;
};

Box unionBox(const Box& a, const Box& b) {
    if (a.isEmpty()) return b;
    if (b.isEmpty()) return a;
    const float3 mn = min(a.getMin(), b.getMin());
    const float3 mx = max(a.getMax(), b.getMax());
    return Box{(mn + mx) * 0.5f, (mx - mn) * 0.5f};
}

Box transformBox(const Box& box, const mat4f& matrix) {
    const float3 mn = box.getMin();
    const float3 mx = box.getMax();
    float3 outMin(FLT_MAX, FLT_MAX, FLT_MAX);
    float3 outMax(-FLT_MAX, -FLT_MAX, -FLT_MAX);
    for (int i = 0; i < 8; ++i) {
        const float3 corner((i & 1) ? mx.x : mn.x,
                (i & 2) ? mx.y : mn.y,
                (i & 4) ? mx.z : mn.z);
        const float3 world = (matrix * float4(corner, 1.0f)).xyz;
        outMin = min(outMin, world);
        outMax = max(outMax, world);
    }
    return Box{(outMin + outMax) * 0.5f, (outMax - outMin) * 0.5f};
}

std::vector<NamedBounds> collectNamedBounds(Engine& engine, FilamentAsset* asset) {
    RenderableManager& rm = engine.getRenderableManager();
    TransformManager& tm = engine.getTransformManager();
    std::vector<NamedBounds> parts;
    const utils::Entity* entities = asset->getRenderableEntities();
    const size_t count = asset->getRenderableEntityCount();
    parts.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const utils::Entity entity = entities[i];
        if (!tm.hasComponent(entity)) {
            continue;
        }
        const char* rawName = asset->getName(entity);
        const std::string name = rawName ? toLower(rawName) : std::string();
        const RenderableManager::Instance instance = rm.getInstance(entity);
        const Box& local = rm.getAxisAlignedBoundingBox(instance);
        const mat4f world = tm.getWorldTransform(tm.getInstance(entity));
        parts.push_back({name, transformBox(local, world)});
    }
    return parts;
}

Box shellBounds(const std::vector<NamedBounds>& parts, const Box& fallback) {
    Box shell{};
    for (const NamedBounds& part : parts) {
        if (startsWith(part.name, "wall") || startsWith(part.name, "floor") ||
                startsWith(part.name, "ceiling")) {
            shell = unionBox(shell, part.box);
        }
    }
    return shell.isEmpty() ? fallback : shell;
}

// Matches RoomLightLayout.kt: "^window(?:[_-]?\d+)?"
std::string windowGroupKey(const std::string& lowerName) {
    if (!startsWith(lowerName, "window")) return {};
    size_t i = 6;
    if (i < lowerName.size() && (lowerName[i] == '_' || lowerName[i] == '-')) {
        const size_t j = i + 1;
        if (j < lowerName.size() && std::isdigit(static_cast<unsigned char>(lowerName[j]))) {
            i = j;
        }
    }
    while (i < lowerName.size() && std::isdigit(static_cast<unsigned char>(lowerName[i]))) {
        ++i;
    }
    return lowerName.substr(0, i);
}

// ---------------------------------------------------------------------------
// Lighting — mirrors PhysicalRoomLighting.kt
// ---------------------------------------------------------------------------

struct LightEntityList {
    std::vector<utils::Entity> entities;
};

utils::Entity createSun(Engine& engine, Scene& scene, bool castShadows, float lux,
        uint32_t mapSize) {
    const float elevation = radians(kSunElevationDeg);
    const float rotation = radians(kSunRotationDeg);
    const float3 direction(-std::cos(elevation) * std::sin(rotation),
            -std::sin(elevation),
            -std::cos(elevation) * std::cos(rotation));

    LightManager::ShadowOptions shadow{};
    shadow.mapSize = mapSize;
    shadow.shadowCascades = 4;
    shadow.stable = true;

    const utils::Entity entity = utils::EntityManager::get().create();
    LightManager::Builder(LightManager::Type::SUN)
            .direction(direction)
            .color(Color::illuminantD(kSunTemperatureK))
            .intensity(lux)
            .sunAngularRadius(radians(1.5f))
            .castShadows(castShadows)
            .shadowOptions(shadow)
            .build(engine, entity);
    scene.addEntity(entity);
    return entity;
}

utils::Entity createLocalLight(Engine& engine, Scene& scene, const float3& position,
        const float3* direction, float watts, float kelvin, float falloff, float bulbRadius,
        bool spot, bool castShadows) {
    LightManager::ShadowOptions shadow{};
    shadow.mapSize = kLocalShadowMapSize;
    shadow.shadowFar = falloff;
    shadow.shadowBulbRadius = bulbRadius;

    LightManager::Builder builder(spot ? LightManager::Type::FOCUSED_SPOT
                                       : LightManager::Type::POINT);
    builder.position(position)
            .color(Color::illuminantD(kelvin))
            .intensity(watts, LightManager::EFFICIENCY_LED)
            .falloff(falloff)
            .castShadows(castShadows)
            .shadowOptions(shadow);
    if (direction) {
        builder.direction(*direction);
        builder.spotLightCone(radians(45.0f), radians(85.0f));
    }

    const utils::Entity entity = utils::EntityManager::get().create();
    builder.build(engine, entity);
    scene.addEntity(entity);
    return entity;
}

void createRoomLights(Engine& engine, Scene& scene, const Box& room,
        const std::vector<NamedBounds>& parts, bool castShadows, float sunLux,
        uint32_t sunMapSize, LightEntityList* lights) {
    const float3 roomMin = room.getMin();
    const float3 roomMax = room.getMax();
    const float3 roomCenter = room.center;
    const float falloff = std::max(length(roomMax - roomMin) * 1.5f, 1.0f);

    lights->entities.push_back(createSun(engine, scene, castShadows && sunLux > 0.0f,
            sunLux, sunMapSize));

    // Ceiling lights: one per "ceiling*" part, just below its lowest point.
    int localCount = 0;
    for (const NamedBounds& part : parts) {
        if (localCount >= 4) break;
        if (!startsWith(part.name, "ceiling")) continue;
        const float3 center = part.box.center;
        const float3 position(center.x, part.box.getMin().y - kCeilingDropM, center.z);
        lights->entities.push_back(createLocalLight(engine, scene, position, nullptr,
                kCeilingWatts, kCeilingTemperatureK, falloff, kCeilingBulbRadiusM,
                false, castShadows));
        ++localCount;
    }

    // Window lights: union parts sharing one window key, point inward and slightly down.
    std::vector<std::string> keys;
    std::vector<Box> groups;
    for (const NamedBounds& part : parts) {
        if (!startsWith(part.name, "window")) continue;
        if (containsAny(part.name, {"drape", "sheer", "curtain", "blind"})) continue;
        const std::string key = windowGroupKey(part.name);
        if (key.empty()) continue;
        const auto it = std::find(keys.begin(), keys.end(), key);
        if (it == keys.end()) {
            keys.push_back(key);
            groups.push_back(part.box);
        } else {
            groups[static_cast<size_t>(it - keys.begin())] =
                    unionBox(groups[static_cast<size_t>(it - keys.begin())], part.box);
        }
    }

    for (size_t i = 0; i < groups.size() && localCount < 4; ++i) {
        const float3 center = groups[i].center;
        float inwardX = roomCenter.x - center.x;
        float inwardZ = roomCenter.z - center.z;
        const float lengthXZ = std::sqrt(inwardX * inwardX + inwardZ * inwardZ);
        if (lengthXZ < 1e-6f) {
            inwardX = 0.0f;
            inwardZ = 1.0f;
        } else {
            inwardX /= lengthXZ;
            inwardZ /= lengthXZ;
        }
        const float directionLength = std::sqrt(1.0f + 0.35f * 0.35f);
        const float3 direction(inwardX / directionLength, -0.35f / directionLength,
                inwardZ / directionLength);
        const float3 position(center.x + inwardX * kWindowInsetM, center.y,
                center.z + inwardZ * kWindowInsetM);
        lights->entities.push_back(createLocalLight(engine, scene, position, &direction,
                kWindowWatts, kWindowTemperatureK, falloff, kWindowBulbRadiusM,
                true, castShadows));
        ++localCount;
    }

    std::printf("[lights] sun=1 local=%d falloff=%.2fm room=%.2f x %.2f x %.2f\n",
            localCount, falloff, roomMax.x - roomMin.x, roomMax.y - roomMin.y,
            roomMax.z - roomMin.z);
}

// ---------------------------------------------------------------------------
// Frame statistics
// ---------------------------------------------------------------------------

struct FrameRecord {
    uint32_t frameId = 0;
    double beginNs = 0.0;
    double endNs = 0.0;
    double backendBeginNs = -1.0;
    double backendEndNs = -1.0;
    double gpuCompleteNs = -1.0;
    double gpuMs = -1.0;
    double denoisedMs = -1.0;
};

// Collects Renderer::FrameInfo entries. Renderer keeps the last 16 frames, so the
// main loop polls once per frame; frames that are still in flight are picked up on a
// later poll (keyed by frameId, so no entry is double-counted or lost).
class FrameStats {
public:
    void merge(const Renderer::FrameInfo& info) {
        if (info.frameId == 0 || info.beginFrame < 0 || info.endFrame < 0) return;
        FrameRecord& record = mRecords[info.frameId];
        record.frameId = info.frameId;
        record.beginNs = static_cast<double>(info.beginFrame);
        record.endNs = static_cast<double>(info.endFrame);
        record.backendBeginNs = static_cast<double>(info.backendBeginFrame);
        record.backendEndNs = static_cast<double>(info.backendEndFrame);
        record.gpuCompleteNs = static_cast<double>(info.gpuFrameComplete);
        if (info.gpuFrameDuration >= 0) {
            record.gpuMs = static_cast<double>(info.gpuFrameDuration) / 1.0e6;
            record.denoisedMs = info.denoisedGpuFrameDuration >= 0
                    ? static_cast<double>(info.denoisedGpuFrameDuration) / 1.0e6
                    : -1.0;
        }
    }

    void printSummary(const Options& options, int width, int height,
            double warmupCutoffNs, size_t skippedFrames) const {
        std::vector<const FrameRecord*> records;
        records.reserve(mRecords.size());
        for (const auto& entry : mRecords) {
            if (entry.second.beginNs >= warmupCutoffNs) {
                records.push_back(&entry.second);
            }
        }
        if (records.size() < 2) {
            std::printf("SUMMARY label=%s frames=%zu (not enough samples)\n",
                    options.label.c_str(), records.size());
            std::fflush(stdout);
            return;
        }

        std::vector<double> intervalsMs;
        std::vector<double> cpuMs;
        std::vector<double> gpuMs;
        intervalsMs.reserve(records.size() - 1);
        cpuMs.reserve(records.size());
        gpuMs.reserve(records.size());
        for (size_t i = 1; i < records.size(); ++i) {
            intervalsMs.push_back(
                    (records[i]->beginNs - records[i - 1]->beginNs) / 1.0e6);
        }
        for (const FrameRecord* record : records) {
            cpuMs.push_back((record->endNs - record->beginNs) / 1.0e6);
            if (record->gpuMs >= 0.0) {
                gpuMs.push_back(record->gpuMs);
            }
        }

        const double wallSeconds =
                (records.back()->endNs - records.front()->beginNs) / 1.0e9;
        const double avgInterval = mean(intervalsMs);
        const double fps = avgInterval > 0.0 ? 1000.0 / avgInterval : 0.0;

        const double intervalP50 = percentile(intervalsMs, 0.50);
        const double intervalP95 = percentile(intervalsMs, 0.95);
        const double intervalP99 = percentile(intervalsMs, 0.99);
        const double cpuP50 = percentile(cpuMs, 0.50);
        const double cpuP95 = percentile(cpuMs, 0.95);
        const double cpuP99 = percentile(cpuMs, 0.99);
        const double gpuAvg = mean(gpuMs);
        const double gpuP50 = percentile(gpuMs, 0.50);
        const double gpuP95 = percentile(gpuMs, 0.95);
        const double gpuP99 = percentile(gpuMs, 0.99);

        if (gpuMs.empty()) {
            std::printf("SUMMARY label=%s frames=%zu skipped=%zu wall=%.2fs avg_fps=%.2f "
                        "interval_ms p50=%.3f p95=%.3f p99=%.3f "
                        "cpu_ms p50=%.3f p95=%.3f p99=%.3f gpu_ms unavailable\n",
                    options.label.c_str(), records.size(), skippedFrames, wallSeconds, fps,
                    intervalP50, intervalP95, intervalP99,
                    cpuP50, cpuP95, cpuP99);
        } else {
            std::printf("SUMMARY label=%s frames=%zu skipped=%zu wall=%.2fs avg_fps=%.2f "
                        "interval_ms p50=%.3f p95=%.3f p99=%.3f "
                        "cpu_ms p50=%.3f p95=%.3f p99=%.3f "
                        "gpu_ms avg=%.3f p50=%.3f p95=%.3f p99=%.3f gpu_samples=%zu\n",
                    options.label.c_str(), records.size(), skippedFrames, wallSeconds, fps,
                    intervalP50, intervalP95, intervalP99,
                    cpuP50, cpuP95, cpuP99,
                    gpuAvg, gpuP50, gpuP95, gpuP99, gpuMs.size());
        }

        const std::string label = csvSafe(options.label);
        if (!options.csvPath.empty()) {
            const bool needsHeader = !std::ifstream(options.csvPath).good();
            std::ofstream out(options.csvPath, std::ios::app);
            if (!out) {
                std::fprintf(stderr, "Cannot open CSV: %s\n", options.csvPath.c_str());
                return;
            }
            if (needsHeader) {
                out << "timestamp,label,preset,shadow,width,height,frames,skipped,wall_s,"
                       "avg_fps,interval_p50_ms,interval_p95_ms,interval_p99_ms,"
                       "cpu_p50_ms,cpu_p95_ms,cpu_p99_ms,"
                       "gpu_avg_ms,gpu_p50_ms,gpu_p95_ms,gpu_p99_ms,gpu_samples\n";
            }
            char timestamp[32];
            const std::time_t now = std::time(nullptr);
            std::tm local{};
            localtime_s(&local, &now);
            std::strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%S", &local);
            out << timestamp << ',' << label << ',' << options.presetName << ','
                << options.shadowType << ',' << width << ',' << height << ','
                << records.size() << ',' << skippedFrames << ',' << wallSeconds << ','
                << fps << ','
                << intervalP50 << ',' << intervalP95 << ',' << intervalP99 << ','
                << cpuP50 << ',' << cpuP95 << ',' << cpuP99 << ','
                << gpuAvg << ',' << gpuP50 << ',' << gpuP95 << ',' << gpuP99 << ','
                << gpuMs.size() << '\n';
        }

        if (!options.frameCsvPath.empty()) {
            std::ofstream out(options.frameCsvPath);
            if (!out) {
                std::fprintf(stderr, "Cannot open frame CSV: %s\n",
                        options.frameCsvPath.c_str());
            } else {
                out << "frame_id,begin_ns,end_ns,cpu_ms,gpu_ms,denoised_gpu_ms,"
                       "interval_ms,backend_ms,gpu_complete_ms\n";
                for (size_t i = 0; i < records.size(); ++i) {
                    const FrameRecord* record = records[i];
                    const double interval = i == 0 ? -1.0
                            : (record->beginNs - records[i - 1]->beginNs) / 1.0e6;
                    const double backendMs = record->backendBeginNs >= 0.0 &&
                            record->backendEndNs >= 0.0
                            ? (record->backendEndNs - record->backendBeginNs) / 1.0e6 : -1.0;
                    const double gpuCompleteMs = record->gpuCompleteNs > 0.0
                            ? (record->gpuCompleteNs - record->beginNs) / 1.0e6 : -1.0;
                    out << record->frameId << ',' << static_cast<int64_t>(record->beginNs)
                        << ',' << static_cast<int64_t>(record->endNs) << ','
                        << (record->endNs - record->beginNs) / 1.0e6 << ','
                        << record->gpuMs << ',' << record->denoisedMs << ','
                        << interval << ',' << backendMs << ',' << gpuCompleteMs << '\n';
                }
            }
        }
        std::fflush(stdout);
    }

private:
    static std::string csvSafe(std::string value) {
        std::replace(value.begin(), value.end(), ',', ';');
        return value;
    }

    static double mean(const std::vector<double>& values) {
        if (values.empty()) return 0.0;
        return std::accumulate(values.begin(), values.end(), 0.0)
                / static_cast<double>(values.size());
    }

    static double percentile(const std::vector<double>& unsorted, double p) {
        if (unsorted.empty()) return 0.0;
        std::vector<double> sorted = unsorted;
        std::sort(sorted.begin(), sorted.end());
        const double position = p * static_cast<double>(sorted.size() - 1);
        const size_t index = static_cast<size_t>(std::lround(position));
        return sorted[std::min(index, sorted.size() - 1)];
    }

    std::map<uint32_t, FrameRecord> mRecords;
};

// ---------------------------------------------------------------------------
// Camera input
// ---------------------------------------------------------------------------

struct FlyCamera {
    float3 eye{0.0f, kEyeHeight, 0.0f};
    float yawDeg = 0.0f;
    float pitchDeg = 0.0f;

    float3 forward() const {
        const float yaw = radians(yawDeg);
        const float pitch = radians(pitchDeg);
        return normalize(float3(-std::sin(yaw) * std::cos(pitch),
                std::sin(pitch),
                -std::cos(yaw) * std::cos(pitch)));
    }

    void apply(Camera* camera) const {
        camera->lookAt(double3(eye), double3(eye + forward()), double3{0.0, 1.0, 0.0});
    }
};

void handleInput(const Options& options, const SDL_Event& event, FlyCamera* camera) {
    if (!options.input) return;
    if (event.type == SDL_MOUSEMOTION && (event.motion.state & SDL_BUTTON_LMASK)) {
        camera->yawDeg -= static_cast<float>(event.motion.xrel) * 0.15f;
        camera->pitchDeg -= static_cast<float>(event.motion.yrel) * 0.15f;
        camera->pitchDeg = std::clamp(camera->pitchDeg, -85.0f, 85.0f);
    }
}

void updateMovement(const Options& options, float deltaSeconds, FlyCamera* camera) {
    if (!options.input) return;
    const Uint8* keys = SDL_GetKeyboardState(nullptr);
    const float3 fwd = camera->forward();
    const float3 right = normalize(cross(fwd, float3{0.0f, 1.0f, 0.0f}));
    float3 move{0.0f};
    if (keys[SDL_SCANCODE_W]) move += fwd;
    if (keys[SDL_SCANCODE_S]) move -= fwd;
    if (keys[SDL_SCANCODE_D]) move += right;
    if (keys[SDL_SCANCODE_A]) move -= right;
    if (keys[SDL_SCANCODE_E]) move.y += 1.0f;
    if (keys[SDL_SCANCODE_Q]) move.y -= 1.0f;
    if (length2(move) > 0.0f) {
        const float speed = (keys[SDL_SCANCODE_LSHIFT] ? 4.0f : 1.5f) * deltaSeconds;
        camera->eye += normalize(move) * speed;
    }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

struct ScreenshotJob {
    std::string path;
    uint32_t width;
    uint32_t height;
};

void captureScreenshot(Renderer* renderer, const std::string& path, int width, int height) {
    const uint32_t w = static_cast<uint32_t>(width);
    const uint32_t h = static_cast<uint32_t>(height);
    const size_t size = static_cast<size_t>(w) * h * 4u;
    auto* job = new ScreenshotJob{path, w, h};
    auto* pixels = new uint8_t[size];
    renderer->readPixels(0, 0, w, h, backend::PixelBufferDescriptor(
            pixels, size, backend::PixelDataFormat::RGBA, backend::PixelDataType::UBYTE,
            [](void* buffer, size_t, void* user) {
                auto* job = static_cast<ScreenshotJob*>(user);
                if (stbi_write_png(job->path.c_str(), static_cast<int>(job->width),
                        static_cast<int>(job->height), 4, buffer,
                        static_cast<int>(job->width) * 4)) {
                    std::printf("[screenshot] wrote %s\n", job->path.c_str());
                } else {
                    std::fprintf(stderr, "[screenshot] failed to write %s\n",
                            job->path.c_str());
                }
                std::fflush(stdout);
                delete[] static_cast<uint8_t*>(buffer);
                delete job;
            }, job));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int run(const Options& options) {
    const Preset preset = resolvePreset(options.presetName);

    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        std::fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    uint32_t windowFlags = SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI;
    windowFlags |= options.headless ? SDL_WINDOW_HIDDEN : SDL_WINDOW_SHOWN;
    SDL_Window* window = SDL_CreateWindow("RoomCanvas - Filament Desktop",
            SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
            options.width, options.height, windowFlags);
    if (!window) {
        std::fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    const Engine::Backend backend =
            options.backend == "opengl" ? Engine::Backend::OPENGL : Engine::Backend::VULKAN;
    backend::VulkanPlatform* vulkanPlatform = nullptr;
    if (backend == Engine::Backend::VULKAN) {
        vulkanPlatform = filamentapp::createVulkanPlatform(options.gpuHint.c_str());
    }

    Engine* engine = Engine::Builder()
            .backend(backend)
            .platform(vulkanPlatform)
            .build();

    int drawableWidth = options.width;
    int drawableHeight = options.height;
    void* nativeWindow = nullptr;
    SwapChain* swapChain = nullptr;
    if (options.headless) {
        swapChain = engine->createSwapChain(static_cast<uint32_t>(drawableWidth),
                static_cast<uint32_t>(drawableHeight), SwapChain::CONFIG_HAS_STENCIL_BUFFER);
    } else {
        SDL_SysWMinfo wmInfo;
        SDL_VERSION(&wmInfo.version);
        if (!SDL_GetWindowWMInfo(window, &wmInfo)) {
            std::fprintf(stderr, "SDL_GetWindowWMInfo failed\n");
            return 1;
        }
        nativeWindow = wmInfo.info.win.window;
        swapChain = engine->createSwapChain(nativeWindow, SwapChain::CONFIG_HAS_STENCIL_BUFFER);
    }

    Renderer* renderer = engine->createRenderer();
    Scene* scene = engine->createScene();
    View* view = engine->createView();
    view->setName("RoomView");
    view->setScene(scene);

    const utils::Entity cameraEntity = utils::EntityManager::get().create();
    Camera* camera = engine->createCamera(cameraEntity);
    view->setCamera(camera);
    camera->setExposure(0.7f, 1.0f / 125.0f, 100.0f);

    auto aspect = static_cast<double>(drawableWidth) / drawableHeight;
    camera->setProjection(kVerticalFovDeg, aspect, kNearPlane, kFarPlane, Camera::Fov::VERTICAL);
    view->setViewport(Viewport{0, 0, static_cast<uint32_t>(drawableWidth),
            static_cast<uint32_t>(drawableHeight)});

    // glTF ------------------------------------------------------------------
    std::ifstream modelStream(options.modelPath, std::ios::binary | std::ios::ate);
    if (!modelStream) {
        std::fprintf(stderr, "Cannot open model: %s\n", options.modelPath.c_str());
        return 1;
    }
    const std::streamsize modelSize = modelStream.tellg();
    modelStream.seekg(0, std::ios::beg);
    std::vector<char> modelBuffer(static_cast<size_t>(modelSize));
    if (!modelStream.read(modelBuffer.data(), modelSize)) {
        std::fprintf(stderr, "Cannot read model: %s\n", options.modelPath.c_str());
        return 1;
    }
    std::printf("[load] glb %s (%.1f MiB)\n", options.modelPath.c_str(),
            static_cast<double>(modelSize) / (1024.0 * 1024.0));

    utils::NameComponentManager* names =
            new utils::NameComponentManager(utils::EntityManager::get());
    MaterialProvider* materials =
            createUbershaderProvider(engine, UBERARCHIVE_DEFAULT_DATA, UBERARCHIVE_DEFAULT_SIZE);
    AssetLoader* assetLoader = AssetLoader::create({engine, materials, names});

    const auto loadingStart = std::chrono::steady_clock::now();
    FilamentAsset* asset = assetLoader->createAsset(
            reinterpret_cast<const uint8_t*>(modelBuffer.data()),
            static_cast<uint32_t>(modelBuffer.size()));
    if (!asset) {
        std::fprintf(stderr, "gltfio failed to parse the asset\n");
        return 1;
    }

    // gltfio can leave the local transform transaction open while building the
    // hierarchy; committing makes getWorldTransform() valid before we read AABBs.
    engine->getTransformManager().commitLocalTransformTransaction();

    ResourceConfiguration resourceConfig{};
    resourceConfig.engine = engine;
    resourceConfig.gltfPath = options.modelPath.c_str();
    resourceConfig.normalizeSkinningWeights = true;
    ResourceLoader* resourceLoader = new ResourceLoader(resourceConfig);
    // These providers hold an Engine* and their destructors touch the JobSystem, so they
    // must be destroyed explicitly before the engine, not by scope unwinding afterwards.
    std::unique_ptr<TextureProvider> stbDecoder(createStbProvider(engine));
    std::unique_ptr<TextureProvider> ktx2Decoder(createKtx2Provider(engine));
    resourceLoader->addTextureProvider("image/png", stbDecoder.get());
    resourceLoader->addTextureProvider("image/jpeg", stbDecoder.get());
    resourceLoader->addTextureProvider("image/ktx2", ktx2Decoder.get());
    if (!resourceLoader->loadResources(asset)) {
        std::fprintf(stderr, "ResourceLoader failed\n");
        return 1;
    }
    asset->releaseSourceData();
    engine->flushAndWait();

    const double loadSeconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - loadingStart).count();
    std::printf("[load] gltfio assets ready in %.2fs (renderables=%zu)\n",
            loadSeconds, asset->getRenderableEntityCount());

    scene->addEntities(asset->getEntities(), asset->getEntityCount());

    RenderableManager& renderableManager = engine->getRenderableManager();
    for (size_t i = 0; i < asset->getRenderableEntityCount(); ++i) {
        const utils::Entity entity = asset->getRenderableEntities()[i];
        const RenderableManager::Instance instance = renderableManager.getInstance(entity);
        renderableManager.setCastShadows(instance, true);
        renderableManager.setReceiveShadows(instance, true);
    }

    // Bounds ----------------------------------------------------------------
    const std::vector<NamedBounds> parts = collectNamedBounds(*engine, asset);
    Box modelBox{};
    for (const NamedBounds& part : parts) {
        modelBox = unionBox(modelBox, part.box);
    }
    const Box roomBox = shellBounds(parts, modelBox);
    std::printf("[bounds] model center=(%.2f, %.2f, %.2f) size=(%.2f, %.2f, %.2f)\n",
            modelBox.center.x, modelBox.center.y, modelBox.center.z,
            modelBox.halfExtent.x * 2.0f, modelBox.halfExtent.y * 2.0f,
            modelBox.halfExtent.z * 2.0f);

    // Environment -----------------------------------------------------------
    std::unique_ptr<IBL> ibl;
    if (!options.iblPath.empty()) {
        ibl = std::make_unique<IBL>(*engine);
        if (!ibl->loadFromEquirect(utils::Path(options.iblPath))) {
            std::fprintf(stderr, "Cannot load IBL: %s\n", options.iblPath.c_str());
            return 1;
        }
        if (IndirectLight* indirectLight = ibl->getIndirectLight()) {
            indirectLight->setIntensity(kEnvironmentIntensity);
            scene->setIndirectLight(indirectLight);
        }
        scene->setSkybox(ibl->getSkybox());
    }

    // Camera placement (mirrors VrWalkthroughActivity.applyModelInstance) -----
    const float3 modelMin = modelBox.getMin();
    const float3 modelMax = modelBox.getMax();
    const float sizeX = modelMax.x - modelMin.x;
    const float sizeZ = modelMax.z - modelMin.z;
    FlyCamera flyCamera;
    flyCamera.eye = float3(modelBox.center.x, modelMin.y + kEyeHeight, modelBox.center.z);
    flyCamera.yawDeg = (sizeX >= sizeZ) ? 90.0f : 0.0f;
    flyCamera.apply(camera);
    std::printf("[camera] eye=(%.2f, %.2f, %.2f) yaw=%.1f fov=%.0f near=%.2f far=%.0f\n",
            flyCamera.eye.x, flyCamera.eye.y, flyCamera.eye.z, flyCamera.yawDeg,
            kVerticalFovDeg, kNearPlane, kFarPlane);

    // Lights ----------------------------------------------------------------
    LightEntityList lights;
    if (preset.localLights) {
        createRoomLights(*engine, *scene, roomBox, parts,
                preset.shadows && options.sunShadows, options.sunLux,
                options.sunMapSize, &lights);
    }

    // View quality ----------------------------------------------------------
    view->setShadowingEnabled(preset.shadows);
    if (preset.shadows) {
        view->setShadowType(options.shadowType == "pcf" ? ShadowType::PCF
                : options.shadowType == "dpcf" ? ShadowType::DPCF
                                               : ShadowType::PCSS);
        View::SoftShadowOptions softShadow{};
        softShadow.penumbraScale = 1.0f;
        softShadow.penumbraRatioScale = 1.0f;
        view->setSoftShadowOptions(softShadow);
    }

    View::AmbientOcclusionOptions ao{};
    ao.enabled = preset.ssao;
    ao.radius = 0.35f;
    ao.intensity = 0.65f;
    ao.resolution = 0.5f;
    ao.quality = View::QualityLevel::MEDIUM;
    ao.lowPassFilter = View::QualityLevel::MEDIUM;
    ao.upsampling = View::QualityLevel::MEDIUM;
    view->setAmbientOcclusionOptions(ao);

    view->setAntiAliasing(preset.fxaa ? View::AntiAliasing::FXAA : View::AntiAliasing::NONE);

    // SceneView 2.3.4 builds its default ColorGrading with ToneMapper.Filmic.
    FilmicToneMapper filmicToneMapper;
    ColorGrading* colorGrading = ColorGrading::Builder()
            .toneMapper(&filmicToneMapper)
            .build(*engine);
    view->setColorGrading(preset.colorGrading ? colorGrading : nullptr);

    // Printed so external samplers (e.g. GPU memory counters) can attach to this PID.
    std::printf("[proc] pid=%ld\n", static_cast<long>(_getpid()));
    std::printf("[preset] %s localLights=%d shadows=%d ssao=%d filmic=%d fxaa=%d\n",
            options.presetName.c_str(), preset.localLights, preset.shadows, preset.ssao,
            preset.colorGrading, preset.fxaa);

    // Main loop -------------------------------------------------------------
    FrameStats stats;
    bool running = true;
    const auto startTime = std::chrono::steady_clock::now();
    auto lastFrameTime = startTime;
    double nextPrintAt = 1.0;
    std::size_t renderedFrames = 0;
    std::size_t skippedFrames = 0;
    // Temporary diagnostics: time spent inside Renderer::beginFrame (which includes the
    // frame-skipper fence check and swapchain acquire).
    double diagBeginTotalNs = 0.0;
    double diagBeginMaxNs = 0.0;
    std::size_t diagBeginCalls = 0;
    double diagRenderTotalMs = 0.0;
    double diagRenderMaxMs = 0.0;
    double diagEndTotalMs = 0.0;
    double diagEndMaxMs = 0.0;
    double diagPaceTotalMs = 0.0;
    double diagPaceMaxMs = 0.0;
    std::size_t diagPaceCalls = 0;
    bool screenshotDone = options.screenshotPath.empty();
    const auto frameBudget = options.maxFps > 0.0f
            ? std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<double>(1.0 / options.maxFps))
            : std::chrono::steady_clock::duration::zero();
    auto nextFrameDeadline = std::chrono::steady_clock::now();

    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) {
                running = false;
            } else if (!options.headless && event.type == SDL_WINDOWEVENT &&
                    event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) {
                SDL_GetWindowSize(window, &drawableWidth, &drawableHeight);
                engine->destroy(swapChain);
                swapChain = engine->createSwapChain(nativeWindow,
                        SwapChain::CONFIG_HAS_STENCIL_BUFFER);
                view->setViewport(Viewport{0, 0, static_cast<uint32_t>(drawableWidth),
                        static_cast<uint32_t>(drawableHeight)});
                aspect = static_cast<double>(drawableWidth) / drawableHeight;
                camera->setProjection(kVerticalFovDeg, aspect, kNearPlane, kFarPlane,
                        Camera::Fov::VERTICAL);
            }
            handleInput(options, event, &flyCamera);
        }

        // Optional frame pacing (e.g. --max-fps=60) emulates a vsync-driven app loop.
        // Sleep until shortly before the deadline, then spin the final couple of
        // milliseconds. Windows timer coalescing makes SDL_Delay() overshoot by tens
        // of milliseconds when the GPU is lightly loaded, which showed up as phantom
        // 60-130 ms frame intervals in the PC-01/PC-02 runs.
        if (frameBudget.count() > 0) {
            const auto paceStart = std::chrono::steady_clock::now();
            if (nextFrameDeadline > paceStart) {
                const auto remaining = nextFrameDeadline - paceStart;
                const auto spinMargin = std::chrono::milliseconds(2);
                if (remaining > spinMargin) {
                    SDL_Delay(static_cast<Uint32>(
                            std::chrono::duration_cast<std::chrono::milliseconds>(
                                    remaining - spinMargin).count()));
                }
                while (std::chrono::steady_clock::now() < nextFrameDeadline) {
                    // Spin-wait the final margin for accurate pacing.
                }
            }
            const double paceMs = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - paceStart).count();
            diagPaceTotalMs += paceMs;
            diagPaceMaxMs = std::max(diagPaceMaxMs, paceMs);
            ++diagPaceCalls;
            nextFrameDeadline += frameBudget;
            const auto afterWait = std::chrono::steady_clock::now();
            if (nextFrameDeadline < afterWait) {
                nextFrameDeadline = afterWait + frameBudget;
            }
        }

        const auto now = std::chrono::steady_clock::now();
        const float deltaSeconds = std::chrono::duration<float>(now - lastFrameTime).count();
        lastFrameTime = now;

        updateMovement(options, deltaSeconds, &flyCamera);
        flyCamera.apply(camera);

        const auto frameStart = std::chrono::steady_clock::now();
        const bool presented = renderer->beginFrame(swapChain);
        // Renderer::beginFrame is allowed to return false ("GPU still busy, skip this
        // frame"), and the caller may ignore that and render anyway; the deferred
        // begin-frame work runs on the first render() call. --ignore-skip forces that
        // behavior so the loop never spins waiting on the frame-skipper fence.
        const bool renderNow = presented || options.ignoreSkip;
        const auto beginEnd = std::chrono::steady_clock::now();
        const double beginNs = static_cast<double>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                        beginEnd - frameStart).count());
        diagBeginTotalNs += beginNs;
        diagBeginMaxNs = std::max(diagBeginMaxNs, beginNs);
        ++diagBeginCalls;
        if (!presented) {
            ++skippedFrames;
            // A real application returns to its event loop (paced by vsync) when
            // beginFrame() asks to skip. Spinning here would enqueue a driver tick()
            // command (and a flush) per iteration, flooding the backend command queue
            // and delaying the very fence the frame skipper is waiting on.
            if (!options.ignoreSkip) {
                SDL_Delay(1);
            }
        }
        if (renderNow) {
            const auto renderStart = std::chrono::steady_clock::now();
            renderer->render(view);
            const auto renderEnd = std::chrono::steady_clock::now();
            if (!screenshotDone &&
                    std::chrono::duration<double>(frameStart - startTime).count() >= 1.5) {
                captureScreenshot(renderer, options.screenshotPath, drawableWidth, drawableHeight);
                screenshotDone = true;
            }
            renderer->endFrame();
            const auto endEnd = std::chrono::steady_clock::now();
            const double renderMs = std::chrono::duration<double, std::milli>(
                    renderEnd - renderStart).count();
            const double endMs = std::chrono::duration<double, std::milli>(
                    endEnd - renderEnd).count();
            diagRenderTotalMs += renderMs;
            diagRenderMaxMs = std::max(diagRenderMaxMs, renderMs);
            diagEndTotalMs += endMs;
            diagEndMaxMs = std::max(diagEndMaxMs, endMs);
            // Renderer keeps the last 16 frame records; poll each frame and merge by
            // frameId. Frames still in flight (gpuFrameDuration == PENDING) are picked
            // up by a later poll.
            for (const Renderer::FrameInfo& info : renderer->getFrameInfoHistory(16)) {
                stats.merge(info);
            }
            ++renderedFrames;
        }
        const auto frameEnd = std::chrono::steady_clock::now();

        const double elapsed = std::chrono::duration<double>(frameEnd - startTime).count();
        if (elapsed >= nextPrintAt) {
            const double beginAvgMs = diagBeginCalls
                    ? diagBeginTotalNs / static_cast<double>(diagBeginCalls) / 1.0e6 : 0.0;
            std::printf("[run] %.1fs rendered=%zu skipped=%zu begin_avg=%.3fms begin_max=%.3fms "
                        "render_avg=%.3fms render_max=%.3fms end_avg=%.3fms end_max=%.3fms "
                        "pace_avg=%.3fms pace_max=%.3fms\n",
                    elapsed, renderedFrames, skippedFrames, beginAvgMs,
                    diagBeginMaxNs / 1.0e6,
                    renderedFrames ? diagRenderTotalMs / static_cast<double>(renderedFrames) : 0.0,
                    diagRenderMaxMs,
                    renderedFrames ? diagEndTotalMs / static_cast<double>(renderedFrames) : 0.0,
                    diagEndMaxMs,
                    diagPaceCalls ? diagPaceTotalMs / static_cast<double>(diagPaceCalls) : 0.0,
                    diagPaceMaxMs);
            diagBeginTotalNs = 0.0;
            diagBeginMaxNs = 0.0;
            diagBeginCalls = 0;
            diagRenderTotalMs = 0.0;
            diagRenderMaxMs = 0.0;
            diagEndTotalMs = 0.0;
            diagEndMaxMs = 0.0;
            diagPaceTotalMs = 0.0;
            diagPaceMaxMs = 0.0;
            diagPaceCalls = 0;
            std::fflush(stdout);
            nextPrintAt = std::floor(elapsed) + 1.0;
        }

        if (options.durationSec > 0.0f && elapsed >= options.durationSec) {
            running = false;
        }
    }

    const double startNs = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                    startTime.time_since_epoch()).count());
    const double warmupCutoffNs = startNs + static_cast<double>(options.warmupSec) * 1.0e9;
    stats.printSummary(options, drawableWidth, drawableHeight, warmupCutoffNs, skippedFrames);

    // Teardown --------------------------------------------------------------
    auto checkpoint = [](const char* step) {
        std::fprintf(stderr, "[teardown] %s\n", step);
        std::fflush(stderr);
    };
    checkpoint("ibl");
    ibl.reset();
    checkpoint("lights");
    for (utils::Entity entity : lights.entities) {
        engine->getLightManager().destroy(entity);
        utils::EntityManager::get().destroy(entity);
    }
    checkpoint("view");
    view->setColorGrading(nullptr);
    engine->destroy(view);
    engine->destroy(scene);
    checkpoint("camera");
    engine->destroyCameraComponent(cameraEntity);
    utils::EntityManager::get().destroy(cameraEntity);
    engine->destroy(renderer);
    engine->destroy(swapChain);
    checkpoint("asset");
    assetLoader->destroyAsset(asset);
    materials->destroyMaterials();
    checkpoint("providers");
    delete resourceLoader;
    delete materials;
    AssetLoader::destroy(&assetLoader);
    delete names;
    // Texture providers reference the engine's job system in their destructor.
    stbDecoder.reset();
    ktx2Decoder.reset();
    checkpoint("engine");
    engine->destroy(&engine);
    checkpoint("sdl");

    SDL_DestroyWindow(window);
    SDL_Quit();
    delete vulkanPlatform;
    checkpoint("done");
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    SDL_SetMainReady();

    Options options;
    if (!parseOptions(argc, argv, &options)) {
        return 0;
    }
    const int result = run(options);
    // Filament's Vulkan loader / SDL static destructors fault during CRT exit on this
    // toolchain (after all rendering and teardown work has completed). Exit explicitly so
    // automation sees a clean status code.
    std::fflush(nullptr);
    std::_Exit(result);
}
