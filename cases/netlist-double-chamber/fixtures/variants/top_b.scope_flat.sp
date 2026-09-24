* 第二分支：把表达式依赖压平为字面量（作用域/依赖不可压平的反例）
.include "cells.inc"
.include "models.inc"
.param wn_b=1u
Xu2 mid_b out_b inv wp=2u
Xu1 in_b mid_b inv wp=2u
R1 out_b 0 1000
C1 out_b 0 1pf
M1 out_b in_b 0 0 nch w=1u l=0.18u
.end
