const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { withEntitlementsPlist, withInfoPlist, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const TARGET = 'MusubiWidgets';
const files = ['WidgetSnapshot.swift', 'WidgetStore.swift', 'WidgetTokens.swift', 'MusubiWidgets.swift'];
const unquote = value => String(value ?? '').replace(/^"|"$/g, '');

function identity(config) {
  const bundle = config.ios?.bundleIdentifier;
  if (!bundle) throw new Error('iOS widgets need ios.bundleIdentifier');
  return { bundle: `${bundle}.widgets`, group: `group.${bundle}.widgets` };
}
function configureProject(project, config) {
  const { bundle } = identity(config);
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const targets = project.pbxNativeTargetSection();
  const existing = Object.entries(targets).find(([, target]) => target && typeof target === 'object' && unquote(target.name) === TARGET);
  let target;
  if (existing) target = { uuid: existing[0], pbxNativeTarget: existing[1] };
  else {
    target = project.addTarget(TARGET, 'app_extension', TARGET, bundle);
    project.addBuildPhase(files.map(file => `${TARGET}/${file}`), 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    const group = project.addPbxGroup(files.map(file => `${TARGET}/${file}`), TARGET, '.');
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  }
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  const configs = project.pbxXCBuildConfigurationSection();
  const hostTarget = project.getFirstTarget().firstTarget;
  if (!hostTarget.dependencies.some(ref => objects.PBXTargetDependency[ref.value]?.target === target.uuid)) {
    project.addTargetDependency(project.getFirstTarget().uuid, [target.uuid]);
  }
  const hostList = project.pbxXCConfigurationList()[hostTarget.buildConfigurationList];
  const hostSettings = configs[hostList.buildConfigurations[0].value].buildSettings;
  for (const reference of list.buildConfigurations) {
    const settings = configs[reference.value].buildSettings;
    Object.assign(settings, {
      PRODUCT_BUNDLE_IDENTIFIER: bundle,
      INFOPLIST_FILE: `${TARGET}/Info.plist`, CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '17.0', SDKROOT: 'iphoneos',
      TARGETED_DEVICE_FAMILY: '"1,2"', APPLICATION_EXTENSION_API_ONLY: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO', CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? hostSettings.CURRENT_PROJECT_VERSION ?? '1',
      MARKETING_VERSION: config.version, SWIFT_EMIT_LOC_STRINGS: 'YES',
    });
    if (hostSettings.DEVELOPMENT_TEAM) settings.DEVELOPMENT_TEAM = hostSettings.DEVELOPMENT_TEAM;
  }
  // App extensions must be embedded and signed when the host is archived.
  const buildFiles = project.pbxBuildFileSection();
  for (const file of Object.values(buildFiles)) {
    if (file && typeof file === 'object' && file.fileRef === target.pbxNativeTarget.productReference) {
      file.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
    }
  }
  return project;
}
function writeFiles(config, root) {
  const { group } = identity(config);
  const output = path.join(root, 'ios', TARGET);
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) {
    const source = ['WidgetSnapshot.swift', 'WidgetStore.swift'].includes(file)
      ? path.join(root, 'modules/musubi-agenda-widget/ios', file) : path.join(root, 'widgets/ios', file);
    fs.copyFileSync(source, path.join(output, file));
  }
  fs.writeFileSync(path.join(output, `${TARGET}.entitlements`), plist.build({ 'com.apple.security.application-groups': [group] }));
  fs.writeFileSync(path.join(output, 'Info.plist'), plist.build({
    CFBundleDisplayName: 'Musubi Widgets', CFBundleName: '$(PRODUCT_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundlePackageType: 'XPC!', CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)', MusubiWidgetAppGroup: group,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
  }));
}
function withIosWidgets(config) {
  const { bundle, group } = identity(config);
  // EAS needs the extension declaration before CNG creates its Xcode target.
  const eas = config.extra?.eas ?? {};
  const build = eas.build ?? {}, experimental = build.experimental ?? {}, ios = experimental.ios ?? {};
  const extensions = ios.appExtensions ?? [];
  config.extra = { ...config.extra, eas: { ...eas, build: { ...build, experimental: { ...experimental, ios: {
    ...ios, appExtensions: [...extensions.filter(item => item.targetName !== TARGET), {
      targetName: TARGET, bundleIdentifier: bundle, entitlements: { 'com.apple.security.application-groups': [group] },
    }],
  } } } } };
  config = withEntitlementsPlist(config, cfg => {
    cfg.modResults['com.apple.security.application-groups'] = [...new Set([...(cfg.modResults['com.apple.security.application-groups'] ?? []), group])];
    return cfg;
  });
  config = withInfoPlist(config, cfg => { cfg.modResults.MusubiWidgetAppGroup = group; return cfg; });
  config = withDangerousMod(config, ['ios', cfg => { writeFiles(cfg, cfg.modRequest.projectRoot); return cfg; }]);
  return withXcodeProject(config, cfg => { configureProject(cfg.modResults, cfg); return cfg; });
}
module.exports = withIosWidgets;
module.exports.configureProject = configureProject;
module.exports.writeFiles = writeFiles;
