const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const { configureProject, writeFiles } = require('../../plugins/withIosWidgets');
const root = path.resolve(__dirname, '../..');
const projectPath = path.join(root, 'ios/Musubi.xcodeproj/project.pbxproj');
const project = xcode.project(projectPath).parseSync();
const config = { ios: { bundleIdentifier: 'dev.frgtn.musubi', buildNumber: '92' }, version: '0.2.2' };
configureProject(project, config);
const once = project.writeSync();
configureProject(project, config);
assert.equal(project.writeSync(), once, 'Repeated prebuild must not duplicate targets, sources or embedding');
const target = Object.entries(project.pbxNativeTargetSection()).filter(([, t]) => typeof t === 'object' && t.name.replaceAll('"', '') === 'MusubiWidgets');
assert.equal(target.length, 1);
const [id, definition] = target[0];
const objects = project.hash.project.objects;
for (const group of Object.values(objects.PBXGroup)) {
 if (group && typeof group === 'object') assert.notEqual(group.path, 'undefined', 'Source groups need a real base path');
}
const sources = definition.buildPhases.map(p => objects.PBXSourcesBuildPhase[p.value]).find(Boolean);
assert.equal(sources.files.length, 4);
const configs = objects.XCConfigurationList[definition.buildConfigurationList].buildConfigurations;
for (const ref of configs) {
 const s = objects.XCBuildConfiguration[ref.value].buildSettings;
 assert.equal(s.CURRENT_PROJECT_VERSION, '92');
 assert.equal(s.PRODUCT_BUNDLE_IDENTIFIER, 'dev.frgtn.musubi.widgets');
 assert.equal(s.IPHONEOS_DEPLOYMENT_TARGET, '17.0');
 assert.equal(s.APPLICATION_EXTENSION_API_ONLY, 'YES');
}
const host = project.getFirstTarget().firstTarget;
assert.ok(host.dependencies.some(ref => objects.PBXTargetDependency[ref.value].target === id));
const copies = host.buildPhases.map(ref => objects.PBXCopyFilesBuildPhase[ref.value]).filter(Boolean);
assert.ok(copies.some(phase => Number(phase.dstSubfolderSpec) === 13 && phase.files.some(ref => objects.PBXBuildFile[ref.value].fileRef === definition.productReference)));
writeFiles(config, root);
const info = plist.parse(fs.readFileSync(path.join(root, 'ios/MusubiWidgets/Info.plist'), 'utf8'));
assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
assert.equal(info.MusubiWidgetAppGroup, 'group.dev.frgtn.musubi.widgets');
assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
const entitlements = plist.parse(fs.readFileSync(path.join(root, 'ios/MusubiWidgets/MusubiWidgets.entitlements'), 'utf8'));
assert.deepEqual(entitlements['com.apple.security.application-groups'], [info.MusubiWidgetAppGroup]);
console.log('iOS extension target, embedding, versions and idempotency: OK');
