* 另一来源的同名子电路：默认值不同（重名冲突用）
.subckt inv in out wp=8u
Mp out in vdd vdd pch w={wp} l=0.18u
Mn out in 0 0 nch w={wp/4} l=0.18u
.ends inv
