Pod::Spec.new do |s|
  s.name           = 'RoveNativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for Rove Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = { 'Hafiezul' => 'hafiezulzikry13@gmail.com' }
  s.homepage       = 'https://rove.hafiezulzikry.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
