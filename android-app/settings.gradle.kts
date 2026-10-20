pluginManagement {
    repositories {
        maven("https://developer.huawei.com/repo/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://developer.huawei.com/repo/")
        google()
        mavenCentral()
    }
}
rootProject.name = "ARViewer"
include(":app")
