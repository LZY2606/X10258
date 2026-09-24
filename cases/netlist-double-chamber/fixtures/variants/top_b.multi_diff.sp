* 边界：多个最小差异（R 值变化 + 新增电容）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xu2 mid_b out_b inv wp={wn_b*2}
Xu1 in_b mid_b inv wp=2u
R1 out_b 0 2k
C1 out_b 0 1pf
C2 out_b 0 2p
M1 out_b in_b 0 0 nch w=1u l=0.18u
.end
