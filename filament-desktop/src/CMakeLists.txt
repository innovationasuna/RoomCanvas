cmake_minimum_required(VERSION 3.22)
project(room_viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Filament was built with USE_STATIC_CRT=ON, so the app must use /MT as well.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(FILAMENT_ROOT "D:/FilamentDesktop/filament" CACHE PATH "Filament source root")
set(FILAMENT_BUILD "${FILAMENT_ROOT}/out/cmake-release" CACHE PATH "Filament build tree")

if (NOT EXISTS "${FILAMENT_BUILD}/filament/filament.lib")
    message(FATAL_ERROR "Filament build not found at ${FILAMENT_BUILD}. Build gltf_viewer first.")
endif()

add_executable(room_viewer src/main.cpp)

target_compile_definitions(room_viewer PRIVATE
        FILAMENT_DRIVER_SUPPORTS_VULKAN
        FILAMENT_SUPPORTS_OPENGL
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        _CRT_SECURE_NO_WARNINGS
)

target_compile_options(room_viewer PRIVATE /utf-8 /EHsc /MP /W3 /O2 /Zi)

set(FILAMENT_INCLUDES
        ${FILAMENT_ROOT}/filament/include
        ${FILAMENT_ROOT}/filament/backend/include
        ${FILAMENT_ROOT}/libs/utils/include
        ${FILAMENT_ROOT}/libs/math/include
        ${FILAMENT_ROOT}/libs/filabridge/include
        ${FILAMENT_ROOT}/libs/filaflat/include
        ${FILAMENT_ROOT}/libs/gltfio/include
        ${FILAMENT_BUILD}/libs/gltfio
        ${FILAMENT_ROOT}/third_party/cgltf/tnt/..
        ${FILAMENT_ROOT}/third_party/robin-map/tnt/..
        ${FILAMENT_ROOT}/third_party/vkmemalloc/tnt/../include
        ${FILAMENT_ROOT}/libs/bluevk/include
        ${FILAMENT_ROOT}/libs/filamentapp/include
        ${FILAMENT_ROOT}/libs/camutils/include
        ${FILAMENT_ROOT}/libs/filagui/include
        ${FILAMENT_ROOT}/third_party/imgui/tnt/..
        ${FILAMENT_ROOT}/third_party/libsdl2/tnt/../include
        ${FILAMENT_ROOT}/third_party/stb/tnt/..
        ${FILAMENT_ROOT}/libs/iblprefilter/include
        ${FILAMENT_ROOT}/libs/image/include
        ${FILAMENT_ROOT}/libs/imageio/include
        ${FILAMENT_ROOT}/libs/ktxreader/include
        ${FILAMENT_ROOT}/libs/geometry/include
        ${FILAMENT_ROOT}/libs/uberz/include
        ${FILAMENT_BUILD}/include
        ${FILAMENT_BUILD}/shaders
        ${FILAMENT_ROOT}/third_party/basisu/tnt/../transcoder
        ${FILAMENT_ROOT}/third_party/zstd/tnt/../lib
        ${FILAMENT_ROOT}/third_party/draco/tnt/../src
        ${FILAMENT_ROOT}/third_party/meshoptimizer/tnt/../src
        ${FILAMENT_ROOT}/third_party/tinyexr/tnt/..
        ${FILAMENT_ROOT}/third_party/libpng/tnt/..
        ${FILAMENT_ROOT}/third_party/libz/tnt/..
        ${FILAMENT_ROOT}/third_party/smol-v/tnt/../source
        ${FILAMENT_ROOT}/third_party/spirv-cross/tnt/..
        ${FILAMENT_ROOT}/third_party/getopt/include
)
target_include_directories(room_viewer PRIVATE ${FILAMENT_INCLUDES})

# Same order as the link line CMake generated for gltf_viewer.
set(FILAMENT_LIBS
        ${FILAMENT_BUILD}/libs/filamentapp/filamentapp.lib
        ${FILAMENT_BUILD}/libs/filamentapp/filamentapp-resources.lib
        ${FILAMENT_BUILD}/libs/gltfio/uberarchive.lib
        ${FILAMENT_BUILD}/libs/gltfio/gltfio.lib
        ${FILAMENT_BUILD}/libs/gltfio/gltfio_core.lib
        ${FILAMENT_BUILD}/third_party/libassimp/tnt/assimp.lib
        ${FILAMENT_BUILD}/libs/camutils/camutils.lib
        ${FILAMENT_BUILD}/libs/iblprefilter/filament-iblprefilter.lib
        ${FILAMENT_BUILD}/third_party/getopt/getopt.lib
        ${FILAMENT_BUILD}/libs/imageio/imageio.lib
        ${FILAMENT_BUILD}/third_party/libpng/tnt/png.lib
        ${FILAMENT_BUILD}/third_party/tinyexr/tnt/tinyexr.lib
        ${FILAMENT_BUILD}/third_party/libz/tnt/z.lib
        ${FILAMENT_BUILD}/third_party/basisu/tnt/basis_encoder.lib
        ${FILAMENT_BUILD}/third_party/libsdl2/tnt/sdl2.lib
        ${FILAMENT_BUILD}/libs/filamat/filamat.lib
        ${FILAMENT_BUILD}/shaders/shaders.lib
        ${FILAMENT_BUILD}/third_party/glslang/tnt/SPIRV/SPIRV.lib
        ${FILAMENT_BUILD}/third_party/glslang/tnt/glslang/glslang.lib
        ${FILAMENT_BUILD}/third_party/glslang/tnt/glslang/OSDependent/Windows/OSDependent.lib
        ${FILAMENT_BUILD}/third_party/spirv-tools/source/opt/SPIRV-Tools-opt.lib
        ${FILAMENT_BUILD}/third_party/spirv-tools/source/SPIRV-Tools.lib
        ${FILAMENT_BUILD}/third_party/spirv-cross/tnt/spirv-cross-glsl.lib
        ${FILAMENT_BUILD}/third_party/spirv-cross/tnt/spirv-cross-msl.lib
        ${FILAMENT_BUILD}/third_party/spirv-cross/tnt/spirv-cross-core.lib
        ${FILAMENT_BUILD}/libs/filagui/filagui.lib
        ${FILAMENT_BUILD}/third_party/imgui/tnt/imgui.lib
        ${FILAMENT_BUILD}/libs/geometry/geometry.lib
        ${FILAMENT_BUILD}/third_party/mikktspace/mikktspace.lib
        ${FILAMENT_BUILD}/libs/ktxreader/ktxreader.lib
        ${FILAMENT_BUILD}/filament/filament.lib
        ${FILAMENT_BUILD}/filament/backend/backend.lib
        ${FILAMENT_BUILD}/libs/bluegl/bluegl.lib
        ${FILAMENT_BUILD}/libs/bluevk/bluevk.lib
        ${FILAMENT_BUILD}/libs/filaflat/filaflat.lib
        ${FILAMENT_BUILD}/third_party/smol-v/tnt/smol-v.lib
        ${FILAMENT_BUILD}/libs/image/image.lib
        ${FILAMENT_BUILD}/third_party/basisu/tnt/basis_transcoder.lib
        ${FILAMENT_BUILD}/third_party/stb/tnt/stb.lib
        ${FILAMENT_BUILD}/libs/uberz/uberzlib.lib
        ${FILAMENT_BUILD}/libs/filabridge/filabridge.lib
        ${FILAMENT_BUILD}/libs/math/math.lib
        ${FILAMENT_BUILD}/libs/utils/utils.lib
        ${FILAMENT_BUILD}/third_party/zstd/tnt/zstd.lib
        ${FILAMENT_BUILD}/third_party/meshoptimizer/tnt/meshoptimizer.lib
        ${FILAMENT_BUILD}/third_party/draco/tnt/dracodec.lib
        ${FILAMENT_BUILD}/third_party/civetweb/tnt/civetweb.lib
)

target_link_libraries(room_viewer PRIVATE
        ${FILAMENT_LIBS}
        winmm imm32 version setupapi ole32 oleaut32 uuid shell32 gdi32 advapi32 user32 opengl32 ws2_32 shlwapi
)
