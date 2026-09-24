* 网表双影室 B 侧顶层（网/实例 alpha-rename + 单位后缀变体）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xu2 mid_b out_b inv wp={wn_b*2}
Xu1 in_b mid_b inv wp=2u
R1 out_b 0 1000
C1 out_b 0 1pf
M1 out_b in_b 0 0 nch w=1u l=0.18u
.end
