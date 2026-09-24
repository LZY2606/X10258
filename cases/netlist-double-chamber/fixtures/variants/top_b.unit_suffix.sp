* 边界：单位后缀与不可转换值（留在原位置并附诊断）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xu2 mid_b out_b inv wp={wn_b*2}
Xu1 in_b mid_b inv wp=2u
R1 out_b 0 1.0k
C1 out_b 0 1e-12
Rpar out_b 0 abc
M1 out_b in_b 0 0 nch w=1u l=0.18u
.end
