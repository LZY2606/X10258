* 与 B 侧对应的未知元件（opaque 对等）
.include "cells.inc"
.include "models.inc"
.param wn=1u
Xinv1 n_in n_mid inv wp=2u
Xinv2 n_mid n_out inv
+ wp={wn*2}
Rload n_out 0 1k
Cload n_out 0 1p
M1 n_out n_in 0 0 nch w=1u l=0.18u
Y1 n_out n_in myfunc
.end
