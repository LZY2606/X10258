* 边界：未知元件（保留 opaque 连接而不删除）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xu2 mid_b out_b inv wp={wn_b*2}
Xu1 in_b mid_b inv wp=2u
R1 out_b 0 1000
C1 out_b 0 1pf
M1 out_b in_b 0 0 nch w=1u l=0.18u
Y1 out_b in_b myfunc
.end
