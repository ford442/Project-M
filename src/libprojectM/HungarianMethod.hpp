#ifndef HUNGARIAN_METHOD_HPP
#define HUNGARIAN_METHOD_HPP
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <limits>

template <int N=20>
class HungarianMethod {
public :
static const size_t MAX_SIZE = N;
private:
size_t n, max_match;
double lx[N], ly[N];
int xy[N]; 
int yx[N];
bool S[N], T[N]; 
double slack[N];
double slackx[N]; 
int prev[N]; 
void init_labels(const double cost[N][N]){
memset(lx, 0, sizeof(lx));
memset(ly, 0, sizeof(ly));
for (unsigned int x = 0; x < n; x++)
for (unsigned int y = 0; y < n; y++)
lx[x] = std::max(lx[x], cost[x][y]);
}
void augment(const double cost[N][N]){
if (max_match == n) return;
unsigned int x, y, root = 0;
int q[N], wr = 0, rd = 0;
memset(S, false, sizeof(S));
memset(T, false, sizeof(T));
memset(prev, -1, sizeof(prev));
for (x = 0; x < n; x++)
if (xy[x] == -1){
q[wr++] = root = x;
prev[x] = -2;
S[x] = true;
break;
}
for (y = 0; y < n; y++){
slack[y] = lx[root] + ly[y] - cost[root][y];
slackx[y] = root;
}
 while (true){
while (rd < wr){
x = q[rd++];
for (y = 0; y < n; y++) 
if (cost[x][y] == lx[x] + ly[y] &&!T[y]){
if (yx[y] == -1) break;
T[y] = true;
q[wr++] = yx[y];
add_to_tree(yx[y], x, cost);
}
if (y < n) break;
}
if (y < n) break;
update_labels();
wr = rd = 0;
for (y = 0; y < n; y++)
if (!T[y] &&slack[y] == 0){
if (yx[y] == -1){
x = slackx[y];
break;
}else{
T[y] = true;
if (!S[yx[y]]){
q[wr++] = yx[y];
add_to_tree(yx[y], slackx[y],cost);
}}}
if (y < n) {break;}
}
if (y < n){
max_match++;
for (int cx = x, cy = y, ty; cx != -2; cx = prev[cx], cy = ty){
ty = xy[cx];
yx[cy] = cx;
xy[cx] = cy;
}
augment(cost);
}}
void update_labels(){
unsigned int x, y;
double delta = std::numeric_limits<double>::max();
for (y = 0; y < n; y++)
if (!T[y])
delta = std::min(delta, slack[y]);
for (x = 0; x < n; x++)
if (S[x]) lx[x] -= delta;
for (y = 0; y < n; y++)
if (T[y]) ly[y] += delta;
for (y = 0; y < n; y++)
if (!T[y])
slack[y] -= delta;
}
void add_to_tree(int x, int prevx, const double cost[N][N]){
S[x] = true;
prev[x] = prevx;
for (unsigned int y = 0; y < n; y++)
if (lx[x] + ly[y] - cost[x][y] < slack[y]){
slack[y] = lx[x] + ly[y] - cost[x][y];
slackx[y] = x;
}}
public:
/// Computes the best matching of two sets given its cost matrix.
/// See the matching() method to get the computed match result.
/// \param cost a matrix of two sets I,J where cost[i][j] is the weight of edge i->j
/// \param logicalSize the number of elements in both I and J
/// \returns the total cost of the best matching
inline double operator()(const double cost[N][N], size_t logicalSize){
n = logicalSize;
assert(n <= N);
double ret = 0;
max_match = 0;
memset(xy, -1, sizeof(xy));
memset(yx, -1, sizeof(yx));
init_labels(cost);
augment(cost);
for (unsigned int x = 0; x < n; x++)
ret += cost[x][xy[x]];
return ret;
}
/// Gets the matching element in 2nd set of the ith element in the first set
/// \param i the index of the ith element in the first set (passed in operator())
/// \returns an index j, denoting the matched jth element of the 2nd set
inline int matching(int i) const {
return xy[i];
}
/// Gets the matching element in 1st set of the jth element in the 2nd set
/// \param j the index of the jth element in the 2nd set (passed in operator())
/// \returns an index i, denoting the matched ith element of the 1st set
/// \note inverseMatching(matching(i)) == i
inline int inverseMatching(int j) const {
return yx[j];
}};
#endif
