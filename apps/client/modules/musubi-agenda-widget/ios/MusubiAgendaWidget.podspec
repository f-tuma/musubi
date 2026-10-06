Pod::Spec.new do |s|
  s.name = 'MusubiAgendaWidget'
  s.version = '1.0.0'
  s.summary = 'Scoped Musubi widget snapshots and action tickets'
  s.description = 'Shares display data with the Musubi WidgetKit extension.'
  s.author = 'f-tuma'
  s.homepage = 'https://github.com/f-tuma/musubi'
  s.license = 'MIT'
  s.platform = :ios, '16.4'
  s.source = { :git => 'https://github.com/f-tuma/musubi.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.swift_version = '5.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
