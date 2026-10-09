; Controlled raised-detail toolpath fixture
G21
G90
M82
G92 X0 Y0 Z0 E0
G0 X80 Y80
G1 Z2.2 F1200
G1 X90 Y90 E1.0 F900
G1 X100 Y90 E2.0
G1 E1.5 F1800 ; retract, not an extrusion path
G0 Z2.6 ; Z hop must not count
G0 X95 Y95
G0 Z2.2
G1 X95 Y100 E2.5
G91
M83
G1 X5 Y0 E0.3
G1 X0 Y5 E-0.1 ; relative retract
G1 E0.2 ; prime only, no path length
G90
G92 E0
G1 X90 Y100 E0.5
