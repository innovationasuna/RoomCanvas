plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hausen3d.arviewer"
    compileSdk = 35
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "com.hausen3d.arviewer"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "0.2.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // SceneView 2.x（View API）：Filament 封装的 glTF 渲染
    implementation("io.github.sceneview:sceneview:2.3.4")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    // HUAWEI AR Engine SDK：运动跟踪、平面检测、命中测试、Anchor
    // （华为设备不可用 ARCore，故不用 SceneView 的 arsceneview，位姿由本 SDK 提供）
    implementation("com.huawei.hms:arenginesdk:4.0.0.5")

    // VrCameraController 是纯 Kotlin 数学，可在 JVM 上直接测真实走动/漂移判定
    testImplementation("junit:junit:4.13.2")
    // RoomShareImport 在 JVM 单测里需要真正的 org.json 实现（Android 上由系统提供）
    testImplementation("org.json:json:20240303")

    // Filament 原生资源生命周期测试：必须在 ARM 真机/模拟器上跑
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
