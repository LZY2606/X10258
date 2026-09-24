* 标准单元库（model 版本与默认值原样保留）
.subckt inv in out wp=4u
Mp out in vdd vdd pch w={wp} l=0.18u
Mn out in 0 0 nch w={wp/4} l=0.18u
.ends inv
