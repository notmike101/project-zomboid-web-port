#include <array>
#include <memory>
#include <cstdint>
#include "BulletCollision/CollisionShapes/btConvexHullShape.h"
#include "BulletCollision/CollisionShapes/btCompoundShape.h"
#include <vector>
#include <cmath>
#include "btBulletDynamicsCommon.h"

// Candidate real Bullet collision core. PZ's embedded upstream revision is unknown.
struct Mesh {
    btCollisionShape* root = nullptr;
    std::vector<btConvexHullShape*> hulls;
    ~Mesh() {
        if (root && root->isCompound()) delete root;
        for (auto* hull : hulls) delete hull;
    }
};
static std::vector<Mesh*> owned;
struct World {
    btDefaultCollisionConfiguration configuration;
    btCollisionDispatcher dispatcher{&configuration};
    btDbvtBroadphase broadphase;
    btSequentialImpulseConstraintSolver solver;
    btDiscreteDynamicsWorld world{&dispatcher,&broadphase,&solver,&configuration};
};
static World* ownedWorld=nullptr;
extern "C" {
int create_world() {
    if(ownedWorld) return 0;
    ownedWorld=new World;
    ownedWorld->world.setGravity(btVector3(0,-10,0));
    return 1;
}
int world_state(double* output) {
    if(!ownedWorld || !output) return 0;
    auto gravity=ownedWorld->world.getGravity();
    for(int i=0;i<3;i++) output[i]=gravity[i];
    output[3]=ownedWorld->world.getNumCollisionObjects();
    output[4]=ownedWorld->world.getNumConstraints();
    return 1;
}
int destroy_world() { if(!ownedWorld) return 0; delete ownedWorld; ownedWorld=nullptr;return 1; }
int scalar_bytes() { return sizeof(btScalar); }
int create_mesh(int compound) {
    auto* mesh = new Mesh;
    if (compound) mesh->root = new btCompoundShape(true);
    owned.push_back(mesh);
    return int(owned.size());
}
int add_hull(int handle, const float* points, int count) {
    if (handle < 1 || handle > int(owned.size()) || !owned[handle-1] || count < 1 || count > 10000 || !points) return 0;
    Mesh* mesh = owned[handle-1];
    if (mesh->root && !mesh->root->isCompound()) return 0;
    for (int i=0;i<count*3;i++) if (!std::isfinite(points[i])) return 0;
    auto* hull = new btConvexHullShape(nullptr,0,32);
    for (int i=0;i<count;i++) hull->addPoint(btVector3(double(points[i*3]),double(points[i*3+1]),double(points[i*3+2])),i==count-1);
    mesh->hulls.push_back(hull);
    if (!mesh->root) mesh->root=hull;
    else { btTransform identity; identity.setIdentity(); static_cast<btCompoundShape*>(mesh->root)->addChildShape(identity,hull); }
    return 1;
}
int get_aabb(int handle, double* output) {
    if(handle<1 || handle>int(owned.size()) || !owned[handle-1] || owned[handle-1]->hulls.empty() || !output) return 0;
    btTransform identity; identity.setIdentity(); btVector3 lo,hi;
    owned[handle-1]->root->getAabb(identity,lo,hi);
    for(int i=0;i<3;i++) { output[i]=lo[i]; output[i+3]=hi[i]; }
    return 1;
}
int child_count(int handle) {
    if(handle<1 || handle>int(owned.size()) || !owned[handle-1]) return -1;
    return int(owned[handle-1]->hulls.size());
}
int point_count(int handle,int child) {
    if(handle<1 || handle>int(owned.size()) || !owned[handle-1] || child<0 || child>=int(owned[handle-1]->hulls.size())) return -1;
    return owned[handle-1]->hulls[child]->getNumPoints();
}
int get_point(int handle,int child,int point,double* output) {
    if(handle<1 || handle>int(owned.size()) || !owned[handle-1] || child<0 || child>=int(owned[handle-1]->hulls.size()) || !output) return 0;
    auto* hull=owned[handle-1]->hulls[child];
    if(point<0 || point>=hull->getNumPoints()) return 0;
    const auto& vector=hull->getUnscaledPoints()[point];
    for(int i=0;i<3;i++) output[i]=vector[i];
    return 1;
}
int clear_mesh(int handle) {
    if(handle<1 || handle>int(owned.size()) || !owned[handle-1]) return 0;
    delete owned[handle-1]; owned[handle-1]=nullptr; return 1;
}
int live_meshes() { int count=0; for(auto* mesh:owned) if(mesh) count++; return count; }
}

// Source-recovered initial native chunk storage only; geometry upload remains unsupported.
struct ChunkRecord {
    void* owner;
    std::array<uint32_t,256> flags{};
    std::array<uintptr_t,640> references{};
    explicit ChunkRecord(void* chunk):owner(chunk){}
};
struct Chunk {
    int x,y;
    int minLevel=0,maxLevel=0;
    std::array<bool,4> owners{};
    std::vector<std::unique_ptr<ChunkRecord>> records;
    Chunk(int wx,int wy):x(wx),y(wy){records.push_back(std::make_unique<ChunkRecord>(this));}
};
struct ChunkMap {
    int id,x,y,width;
    std::vector<std::shared_ptr<Chunk>> cells;
    ChunkMap(int player,int wx,int wy,int size):id(player),x(wx),y(wy),width(size),cells(size*size){}
    std::shared_ptr<Chunk> at(int wx,int wy) const {
        if(wx<x||wy<y||int64_t(wx)>=int64_t(x)+width||int64_t(wy)>=int64_t(y)+width)return nullptr;
        return cells[(wx-x)*width+wy-y];
    }
};
static std::array<std::unique_ptr<ChunkMap>,4> activeMaps;
static std::array<int,6> worldHeader;
extern "C" {
int create_mapped_world(const int* header){
    if(!header||ownedWorld||header[0]<-250||header[1]<-250||header[2]>250||header[3]>250||header[2]<header[0]||header[3]<header[1]||header[4]!=header[0]*256||header[5]!=header[1]*256)return 0;
    if(create_world()!=1)return 0;
    for(int i=0;i<6;i++)worldHeader[i]=header[i];
    return 1;
}
int activate_map(int id,int x,int y,int width){
    if(!ownedWorld||id<0||id>=4||activeMaps[id]||width!=13||int64_t(x)+width>INT32_MAX||int64_t(y)+width>INT32_MAX)return 0;
    auto pending=std::make_unique<ChunkMap>(id,x,y,width);
    for(int dx=0;dx<width;dx++)for(int dy=0;dy<width;dy++){
        std::shared_ptr<Chunk> chunk;
        for(int other=0;other<4;other++)if(activeMaps[other]){
            chunk=activeMaps[other]->at(x+dx,y+dy);
            if(chunk)break;
        }
        if(!chunk)chunk=std::make_shared<Chunk>(x+dx,y+dy);
        pending->cells[dx*width+dy]=chunk;
    }
    for(auto& chunk:pending->cells)chunk->owners[id]=true;
    activeMaps[id]=std::move(pending);
    return 1;
}
int world_header(int* output){
    if(!ownedWorld||!output)return 0;
    for(int i=0;i<6;i++)output[i]=worldHeader[i];
    return 1;
}
int deactivate_map(int id){
    if(!ownedWorld||id<0||id>=4)return 0;
    if(activeMaps[id]){
        for(auto& chunk:activeMaps[id]->cells)chunk->owners[id]=false;
        activeMaps[id].reset();
    }
    return 1;
}
int map_info(int id,int* output){
    if(id<0||id>=4||!activeMaps[id]||!output)return 0;
    auto& map=*activeMaps[id];
    output[0]=map.id;output[1]=map.x;output[2]=map.y;output[3]=map.width;
    output[4]=std::max(map.width/2-1,0);output[5]=std::min(map.width/2+1,map.width);
    return 1;
}
uintptr_t map_chunk(int id,int x,int y,int* output){
    if(id<0||id>=4||!activeMaps[id]||!output)return 0;
    auto chunk=activeMaps[id]->at(x,y);
    if(!chunk)return 0;
    output[0]=chunk->x;output[1]=chunk->y;output[2]=0;
    for(int player=0;player<4;player++)if(chunk->owners[player])output[2]|=1<<player;
    output[3]=chunk->minLevel;output[4]=chunk->maxLevel;output[5]=chunk->records.size();output[6]=0;
    output[7]=1;
    for(auto& record:chunk->records){
        for(auto value:record->flags)if(value)output[6]++;
        for(auto value:record->references)if(value)output[6]++;
        if(record->owner!=chunk.get())output[7]=0;
    }
    return reinterpret_cast<uintptr_t>(chunk.get());
}
int destroy_mapped_world(){
    if(!ownedWorld)return 0;
    for(int player=0;player<4;player++)deactivate_map(player);
    return destroy_world();
}
}
