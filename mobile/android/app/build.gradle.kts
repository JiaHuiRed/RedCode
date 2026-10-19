import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val webApp = rootProject.projectDir.resolve("../../packages/app").canonicalFile
val bundledWebAssets = layout.buildDirectory.dir("generated/assets/web")

val buildWebApp by tasks.registering(Exec::class) {
  workingDir(webApp)
  commandLine("bun", "run", "build")
  inputs.files(
    fileTree(webApp) {
      include("index.html", "vite.config.ts", "vite.ts", "package.json", "src/**", "public/**")
    },
  )
  outputs.dir(webApp.resolve("dist"))
}

val copyWebAssets by tasks.registering(Copy::class) {
  dependsOn(buildWebApp)
  from(webApp.resolve("dist"))
  into(bundledWebAssets)
}

android {
  namespace = "ai.redcode.mobile"
  compileSdk = 36

  defaultConfig {
    applicationId = "ai.redcode.mobile"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.12.15"
  }

  sourceSets.getByName("main").assets.srcDir(bundledWebAssets)

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

tasks.named("preBuild").configure {
  dependsOn(copyWebAssets)
}

dependencies {
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  implementation("androidx.webkit:webkit:1.14.0")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20240303")
}
