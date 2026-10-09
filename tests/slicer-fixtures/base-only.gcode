; Controlled base-only toolpath fixture; tall travels are not extrusion
G21
G90
M82
G92 X0 Y0 Z0 E0
G1 Z0.2 F1200
G1 X80 Y80 E1.0 F900
G1 X100 Y80 E2.0
G1 Z2.0 ; travel through the base height
G1 X90 Y90
G1 E1.5 ; retract
G0 Z2.6 ; maximum G-code Z is deliberately above the base
G0 X90 Y100
G0 Z2.0
G1 X90 Y100 E2.5 ; extrusion at baseZ is not raised detail
G92 E0
G1 E0.5 ; prime only
