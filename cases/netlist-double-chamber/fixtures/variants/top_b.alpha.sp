* 第二分支：整表 alpha-rename（节点与实例可重命名）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xg2 z_mid z_out inv wp={wn_b*2}
Xg1 z_in z_mid inv wp=2u
Rx z_out 0 1000
Cx z_out 0 1pf
M1 z_out z_in 0 0 nch w=1u l=0.18u
.end
