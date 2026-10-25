#include <map>
extern "C" int clear_registered_vehicle();
extern "C" int clear_geometry();
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
    int bodyReferences = 0;
    std::vector<btConvexHullShape*> hulls;
    ~Mesh() {
        if (root && root->isCompound()) delete root;
        for (auto* hull : hulls) delete hull;
    }
};
static std::vector<Mesh*> owned;
static std::map<int,int> registeredMeshes;
extern "C" int registered_mesh_references(int handle);
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
    if (registered_mesh_references(handle) || (mesh->root && !mesh->root->isCompound())) return 0;
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
    if(registered_mesh_references(handle))return 0;
    for(auto it=registeredMeshes.begin();it!=registeredMeshes.end();)if(it->second==handle)it=registeredMeshes.erase(it);else ++it;
    delete owned[handle-1]; owned[handle-1]=nullptr; return 1;
}
int live_meshes() { int count=0; for(auto* mesh:owned) if(mesh) count++; return count; }
}

// Source-recovered initial native chunk storage only; geometry upload remains unsupported.
static void clear_chunk_geometry(int x,int y);
struct ChunkRecord {
    void* owner;
    bool loaded=false, published=false, needed=false;
    std::array<int,256> cells{};
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
static Mesh* registeredMesh(int index){
    auto it=registeredMeshes.find(index);
    return it!=registeredMeshes.end()&&it->second>=1&&it->second<=int(owned.size())?owned[it->second-1]:nullptr;
}
static bool validCell(int encoded){return encoded>=0&&encoded<=255&&(encoded<=10||registeredMesh(encoded-11));}
extern "C" int bind_static_mesh(int index,int handle){
    if(!ownedWorld||index<0||index>10000||handle<1||handle>int(owned.size())||!owned[handle-1]||!owned[handle-1]->root||owned[handle-1]->hulls.empty())return 0;
    auto it=registeredMeshes.find(index);if(it!=registeredMeshes.end()&&it->second!=handle)return 0;
    registeredMeshes[index]=handle;return 1;
}
extern "C" int has_static_mesh(int index){return ownedWorld&&registeredMesh(index)?1:0;}
extern "C" int registered_mesh_references(int handle){
    int count=0;
    for(int i=0;i<int(owned.size());i++)if(owned[i]&&(handle==0||handle==i+1))count+=owned[i]->bodyReferences;
    for(auto& map:activeMaps)if(map)for(auto& chunk:map->cells)for(auto& record:chunk->records)for(int encoded:record->cells)if(encoded>=11){
        auto it=registeredMeshes.find(encoded-11);if(it!=registeredMeshes.end()&&(handle==0||it->second==handle))count++;
    }
    return count;
}

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
        for(auto& chunk:activeMaps[id]->cells){chunk->owners[id]=false;if(std::none_of(chunk->owners.begin(),chunk->owners.end(),[](bool owner){return owner;}))clear_chunk_geometry(chunk->x,chunk->y);}
        activeMaps[id].reset();
    }
    return 1;
}
int scroll_map(int id,int direction){
    if(!ownedWorld||id<0||id>=4||!activeMaps[id]||direction<0||direction>3)return 0;
    auto& map=*activeMaps[id];
    int64_t x=int64_t(map.x)+(direction==0?-1:direction==1?1:0);
    int64_t y=int64_t(map.y)+(direction==2?-1:direction==3?1:0);
    if(x<INT32_MIN||y<INT32_MIN||x+map.width>INT32_MAX||y+map.width>INT32_MAX)return 0;
    auto pending=std::make_unique<ChunkMap>(id,int(x),int(y),map.width);
    for(int dx=0;dx<map.width;dx++)for(int dy=0;dy<map.width;dy++){
        std::shared_ptr<Chunk> chunk;
        for(const auto& other:activeMaps)if(other){
            chunk=other->at(int(x)+dx,int(y)+dy);
            if(chunk)break;
        }
        if(!chunk)chunk=std::make_shared<Chunk>(int(x)+dx,int(y)+dy);
        pending->cells[dx*map.width+dy]=chunk;
    }
    for(const auto& chunk:map.cells)if(!pending->at(chunk->x,chunk->y)){
        chunk->owners[id]=false;
        if(std::none_of(chunk->owners.begin(),chunk->owners.end(),[](bool owner){return owner;}))clear_chunk_geometry(chunk->x,chunk->y);
    }
    for(const auto& chunk:pending->cells)chunk->owners[id]=true;
    activeMaps[id]=std::move(pending);
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
    clear_registered_vehicle();
    clear_geometry();
    for(int player=0;player<4;player++)deactivate_map(player);
    return destroy_world();
}
}


// Private contained geometry build/clear component; native publication callbacks are separate.
struct GeometryBody {
    int chunkX=0,chunkY=0,level=0;
    short mask=14;
    std::unique_ptr<btCollisionShape> shape;
    std::vector<std::unique_ptr<btBoxShape>> children;
    std::unique_ptr<btCollisionObject> body;
    bool rigid=true;
    Mesh* borrowedMesh=nullptr;
    std::unique_ptr<btMotionState> motionState;
    ~GeometryBody(){body.reset();motionState.reset();if(borrowedMesh)borrowedMesh->bodyReferences--;}
    GeometryBody(double x,double y,double z,Mesh* mesh):borrowedMesh(mesh){
        btTransform transform;transform.setIdentity();transform.setOrigin(btVector3(x,y,z));
        motionState=std::make_unique<btDefaultMotionState>(transform);
        btRigidBody::btRigidBodyConstructionInfo info(0,motionState.get(),mesh->root,btVector3(0,0,0));
        body=std::make_unique<btRigidBody>(info);mesh->bodyReferences++;
    }
    GeometryBody(double x,double y,double z,double hx,double hy,double hz) {
        shape=std::make_unique<btBoxShape>(btVector3(hx,hy,hz));
        btRigidBody::btRigidBodyConstructionInfo info(0,nullptr,shape.get(),btVector3(0,0,0));
        body=std::make_unique<btRigidBody>(info);
        btTransform transform;transform.setIdentity();transform.setOrigin(btVector3(x,y,z));
        body->setWorldTransform(transform);
    }
    GeometryBody(double x,double y,double z,bool west) {
        rigid=false;mask=13;
        auto compound=std::make_unique<btCompoundShape>();
        children.push_back(std::make_unique<btBoxShape>(btVector3(.5,double(float(.05))*.5,double(float(.2))*.5)));
        children.push_back(std::make_unique<btBoxShape>(btVector3(.5,double(float(.2))*.5,double(float(.05))*.5)));
        const double rise=2.449490010738373/12;
        double height=rise*.5,depth=1.75;
        for(int i=0;i<12;i++){
            btTransform local;local.setIdentity();local.setOrigin(btVector3(0,height,depth));
            compound->addChildShape(local,children[0].get());height+=rise;depth-=.25;
        }
        height=0;depth=1.875;
        for(int i=0;i<12;i++){
            btTransform local;local.setIdentity();local.setOrigin(btVector3(0,height,depth));
            compound->addChildShape(local,children[1].get());height+=rise;depth-=.25;
        }
        shape=std::move(compound);body=std::make_unique<btCollisionObject>();
        body->setCollisionShape(shape.get());body->setCollisionFlags(btCollisionObject::CF_STATIC_OBJECT);
        btTransform transform;transform.setIdentity();transform.setOrigin(btVector3(x,y,z));
        if(west)transform.setBasis(btMatrix3x3(0,0,1,0,1,0,-1,0,0));
        body->setWorldTransform(transform);
    }
};
static std::vector<std::unique_ptr<GeometryBody>> geometryBodies;
static void removeGeometryBody(GeometryBody& entry){
    if(entry.rigid)ownedWorld->world.removeRigidBody(btRigidBody::upcast(entry.body.get()));
    else ownedWorld->world.removeCollisionObject(entry.body.get());
}
static void addGeometryBody(GeometryBody& entry){
    if(entry.rigid)ownedWorld->world.addRigidBody(btRigidBody::upcast(entry.body.get()),1,entry.mask);
    else ownedWorld->world.addCollisionObject(entry.body.get(),1,entry.mask);
}
extern "C" {
int clear_geometry(){
    if(!ownedWorld)return 0;
    for(auto& entry:geometryBodies)removeGeometryBody(*entry);
    geometryBodies.clear();return 1;
}
int build_geometry(int wx,int wy,int level,const int* cells){
    if(!ownedWorld||!cells||(level<0||level>63))return 0;
    std::shared_ptr<Chunk> chunk;
    for(auto& map:activeMaps)if(map){chunk=map->at(wx,wy);if(chunk)break;}
    if(!chunk)return 0;
    for(int i=0;i<256;i++)if(!validCell(cells[i]))return 0;
    for(int square=0;square<64;square++){int stairs=0;for(int slot=0;slot<4;slot++)if(cells[square*4+slot]==8||cells[square*4+slot]==9)stairs++;if(stairs>1)return 0;}
    bool floor[8][8]{};bool west[8][8]{};bool north[8][8]{};bool south[8][8]{};bool east[8][8]{};
    std::vector<std::unique_ptr<GeometryBody>> pending;
    const double scale=0.8164966702461243;
    const double height=double(float(level)*3.0f)*scale;
    const double baseX=wx*8-worldHeader[4],baseY=wy*8-worldHeader[5];
    auto add=[&](double x,double y,double z,double hx,double hy,double hz){auto body=std::make_unique<GeometryBody>(x,y,z,hx,hy,hz);body->chunkX=wx;body->chunkY=wy;body->level=level;pending.push_back(std::move(body));};
    for(int x=0;x<8;x++)for(int y=0;y<8;y++)for(int slot=0;slot<4;slot++){
        int id=cells[(x*8+y)*4+slot];
        if(id>=11){
            // Native 0x18002ef20 uses float world-relative square centers and float(level)*3 height.
            auto body=std::make_unique<GeometryBody>(double(float(wx*8+x)-float(worldHeader[4])+.5f),height,double(float(wy*8+y)-float(worldHeader[5])+.5f),registeredMesh(id-11));
            body->chunkX=wx;body->chunkY=wy;body->level=level;pending.push_back(std::move(body));
        }
        if(id==1||id==10){
            add(baseX+x+0.5,height+1,baseY+y+0.5,0.5,1,0.5);
            if(id==10)pending.back()->mask=6; // Native SolidStairs 0x18002db90 uses group1/mask6.
        }
        if(id==6)add(baseX+x+0.60000000149011612,height+1,baseY+y+0.60000000149011612,0.10000000149011612,1,0.10000000149011612);
        if(id==7)floor[x][y]=true;
        if(id==3)west[x][y]=true;
        if(id==2)north[x][y]=true;
        if(id==4)south[x][y]=true;
        if(id==5)east[x][y]=true;
        if(id==8||id==9){
            bool west=id==9;
            auto stair=std::make_unique<GeometryBody>(baseX+x+(west?double(float(.2))*.5:.5),height+double(float(.05))*.5,baseY+y+(west?.5:double(float(.2))*.5),west);
            stair->chunkX=wx;stair->chunkY=wy;stair->level=level;pending.push_back(std::move(stair));
        }
    }
    // Native floor 0x180002770 forms row runs, then merges matching adjacent runs.
    int widths[8][8]{};
    for(int y=0;y<8;y++)for(int x=0;x<8;){
        if(!floor[x][y]){x++;continue;}
        int width=1;while(x+width<8&&floor[x+width][y])width++;
        widths[x][y]=width;x+=width;
    }
    for(int y=0;y<8;y++)for(int x=0;x<8;x++)if(widths[x][y]){
        int width=widths[x][y],length=1;
        while(y+length<8&&widths[x][y+length]==width){widths[x][y+length]=0;length++;}
        add(baseX+x+width*0.5,height-0.05000000074505806,baseY+y+length*0.5,(width+0.02)*0.5,0.05000000074505806,(length+0.02)*0.5);
    }
    // Encoded west/north IDs merge only collinear contiguous cells.
    for(int x=0;x<8;x++)for(int y=0;y<8;){
        if(!west[x][y]){y++;continue;}
        int length=1;while(y+length<8&&west[x][y+length])length++;
        add(baseX+x+0.05000000074505806,height+1.2247450053691864,baseY+y+length*0.5,0.05000000074505806,1.2247450053691864,length*0.5);y+=length;
    }
    for(int y=0;y<8;y++)for(int x=0;x<8;){
        if(!north[x][y]){x++;continue;}
        int length=1;while(x+length<8&&north[x+length][y])length++;
        add(baseX+x+length*0.5,height+1.2247450053691864,baseY+y+0.05000000074505806,length*0.5,1.2247450053691864,0.05000000074505806);x+=length;
    }
    for(int x=0;x<8;x++)for(int y=0;y<8;){
        if(!east[x][y]){y++;continue;}
        int length=1;while(y+length<8&&east[x][y+length])length++;
        add(baseX+x+0.94999999925494194,height+1.2247450053691864,baseY+y+length*.5,.05000000074505806,1.2247450053691864,length*.5);y+=length;
    }
    for(int y=0;y<8;y++)for(int x=0;x<8;){
        if(!south[x][y]){x++;continue;}
        int length=1;while(x+length<8&&south[x+length][y])length++;
        add(baseX+x+length*.5,height+1.2247450053691864,baseY+y+.94999999925494194,length*.5,1.2247450053691864,.05000000074505806);x+=length;
    }
    for(auto entry=geometryBodies.begin();entry!=geometryBodies.end();){
        if((*entry)->chunkX==wx&&(*entry)->chunkY==wy&&(*entry)->level==level){removeGeometryBody(**entry);entry=geometryBodies.erase(entry);}else ++entry;
    }
    for(auto& entry:pending){addGeometryBody(*entry);geometryBodies.push_back(std::move(entry));}return 1;
}
int geometry_count(){return geometryBodies.size();}
int geometry_body(int index,double* output){
    if(index<0||index>=int(geometryBodies.size())||!output)return 0;
    auto& entry=*geometryBodies[index];
    auto transform=entry.body->getWorldTransform();btVector3 min,max;auto* actualShape=entry.body->getCollisionShape();actualShape->getAabb(transform,min,max);
    output[0]=actualShape->getShapeType();
    for(int axis=0;axis<3;axis++){output[1+axis]=transform.getOrigin()[axis];output[4+axis]=min[axis];output[7+axis]=max[axis];}
    return 1;
}
}


#include "BulletDynamics/Vehicle/btRaycastVehicle.h"
struct VehicleBox { int type; btVector3 offset,extents,rotation; double radius; };
struct VehicleWheel { bool front; btVector3 connection; double radius; };
struct VehicleDefinition {
    std::array<double,10> values;
    std::vector<VehicleBox> boxes;
    std::vector<VehicleWheel> wheels;
};
static std::map<int, std::unique_ptr<VehicleDefinition>> vehicleDefinitions;
static VehicleDefinition* vehicleDefinition = nullptr;
// Native PZVehicleRaycaster0x180014ef0 uses group2/mask13, preserving real closest-hit/body rules.
class NativeVehicleRaycaster final : public btVehicleRaycaster {
    btDynamicsWorld* world;
public:
    explicit NativeVehicleRaycaster(btDynamicsWorld* value):world(value){}
    void* castRay(const btVector3& from,const btVector3& to,btVehicleRaycasterResult& result) override {
        btCollisionWorld::ClosestRayResultCallback hit(from,to);
        hit.m_collisionFilterGroup=2;hit.m_collisionFilterMask=13;
        world->rayTest(from,to,hit);
        if(!hit.hasHit())return nullptr;
        const btRigidBody* body=btRigidBody::upcast(hit.m_collisionObject);
        if(!body||!body->hasContactResponse())return nullptr;
        result.m_hitPointInWorld=hit.m_hitPointWorld;
        result.m_hitNormalInWorld=hit.m_hitNormalWorld.normalized();
        result.m_distFraction=hit.m_closestHitFraction;
        return const_cast<btRigidBody*>(body);
    }
};
struct OwnedVehicle {
    int id;
    VehicleDefinition* definition=nullptr;
    bool active=false, isStatic=false, hasPublishedStep=false, collisionEvent=false;
    double velocityThreshold=100000, velocityMultiplier=1;
    btVector3 previousLinear{0,0,0}, previousAngular{0,0,0};
    std::array<float,8> inflation{};
    std::array<bool,8> removed{}, present{};
    std::vector<std::unique_ptr<btCollisionShape>> shapes;
    std::unique_ptr<btCompoundShape> compound;
    std::unique_ptr<btDefaultMotionState> motion;
    std::unique_ptr<btRigidBody> body;
    std::unique_ptr<NativeVehicleRaycaster> raycaster;
    std::unique_ptr<btRaycastVehicle> vehicle;
};
static std::map<int,std::unique_ptr<OwnedVehicle>> ownedVehicles;
static std::vector<int> vehicleReadback;
static bool vehicleReadbackValid=false;
static OwnedVehicle* findVehicle(int id){auto found=ownedVehicles.find(id);return found==ownedVehicles.end()?nullptr:found->second.get();}
static OwnedVehicle* singleVehicle(){return ownedVehicles.size()==1?ownedVehicles.begin()->second.get():nullptr;}
static OwnedVehicle* vehicleForBody(const btCollisionObject* body){for(const auto& entry:ownedVehicles)if(entry.second->body.get()==body)return entry.second.get();return nullptr;}
static bool vehicle_region_published(const OwnedVehicle& owner);
// Original PZBullet callback at 0x18002e690, decoded instruction-for-instruction.
// It acts only when contact object A is the vehicle root, preserving Bullet order.
static bool nativeContactAdded(btManifoldPoint& point,const btCollisionObjectWrapper* first,int,int,const btCollisionObjectWrapper* second,int,int){
    const auto* a=first->getCollisionObject();const auto* b=second->getCollisionObject();
    auto* ownedVehicle=vehicleForBody(a);if(!ownedVehicle)return false;
    auto* otherVehicle=vehicleForBody(b);
    bool known=otherVehicle!=nullptr;if(!known)for(const auto& entry:geometryBodies)if(entry->body.get()==b){known=true;break;}
    if(!known)return false;
    ownedVehicle->collisionEvent=true;
    if(otherVehicle)otherVehicle->collisionEvent=true;
    point.m_combinedFriction=btMin(btScalar(10),btMax(btScalar(-10),a->getFriction()*double(0.8999999761581421)));
    point.m_combinedRestitution=a->getRestitution()*0.1;
    return true;
}

// Native pre-tick callback 0x1800323f0. History is stored before multiplier scaling.
static void nativeVehiclePreTick(btDynamicsWorld*,btScalar){
    for(const auto& entry:ownedVehicles){
    auto& owner=*entry.second;auto& body=*owner.body;
    auto linear=body.getLinearVelocity();auto angular=body.getAngularVelocity();
    auto magnitude=[](const btVector3& value){return std::sqrt(value.y()*value.y()+value.x()*value.x()+value.z()*value.z());};
    if(!owner.isStatic&&magnitude(linear)>double(0.10000000149011612)&&magnitude(linear)-magnitude(owner.previousLinear)>3.5){
        auto difference=linear-owner.previousLinear;linear=owner.previousLinear+difference*(3.5/magnitude(difference));body.setLinearVelocity(linear);
    }
    owner.previousLinear=linear;
    if(!owner.isStatic&&magnitude(angular)>double(0.10000000149011612)&&magnitude(angular)-magnitude(owner.previousAngular)>3){
        auto difference=angular-owner.previousAngular;angular=owner.previousAngular+difference*(3/magnitude(difference));body.setAngularVelocity(angular);
    }
    owner.previousAngular=angular;
    if(magnitude(linear)>owner.velocityThreshold)body.setLinearVelocity(linear*owner.velocityMultiplier);
    }
}
extern "C" int set_vehicle_velocity_multiplier(int id,float threshold,float multiplier){
    auto* ownedVehicle=findVehicle(id);
    if(!ownedVehicle||ownedVehicle->id!=id||!std::isfinite(threshold)||!std::isfinite(multiplier)||threshold<0||multiplier<0||multiplier>1)return 0;
    ownedVehicle->velocityThreshold=threshold;ownedVehicle->velocityMultiplier=multiplier;return 1;
}
// Original control helper 0x1800126b0; typed native definition fields remain owned.
extern "C" int control_vehicle(int id,float engineForce,float brakingForce,float steering){
    auto* ownedVehicle=findVehicle(id);
    auto* vehicleDefinition=ownedVehicle?ownedVehicle->definition:nullptr;
    if(!ownedVehicle||ownedVehicle->id!=id||!vehicleDefinition)return 0;
    for(float value:{engineForce,brakingForce,steering})if(!std::isfinite(value))return 0;
    if(brakingForce<0)return 0;
    auto& owner=*ownedVehicle;auto& vehicle=*owner.vehicle;
    const double stoppedBrake=engineForce==0?vehicleDefinition->values[9]:0;
    const double speedFraction=btMin(1.0,btMax(0.0,std::abs(vehicle.getCurrentSpeedKmHour())/owner.velocityThreshold));
    for(int index=0;index<vehicle.getNumWheels();index++){
        double brake=owner.inflation[index]>=1?0:(1-double(owner.inflation[index]))*300*speedFraction;
        double force=0;
        if(vehicleDefinition->wheels[index].front){
            if(!owner.present[index])brake=10;
            vehicle.setSteeringValue(double(steering),index);brake+=stoppedBrake;
        }else if(!owner.present[index])brake=stoppedBrake+10;
        else{force=double(engineForce);brake+=double(brakingForce)+stoppedBrake;}
        vehicle.applyEngineForce(force,index);vehicle.setBrake(brake,index);
    }
    return 1;
}
extern "C" int apply_central_force(int id,float x,float y,float z){
    auto* ownedVehicle=findVehicle(id);
    if(!ownedVehicle||ownedVehicle->id!=id||!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z))return 0;
    // Original JNI0x180009760 accumulates force with actual per-axis linear factors.
    ownedVehicle->body->applyCentralForce(btVector3(double(x),double(y),double(z)));return 1;
}
static btQuaternion nativeEuler(const btVector3& degrees){
    double x=degrees.x()*3.141592653589793/180.0*0.5,y=degrees.y()*3.141592653589793/180.0*0.5,z=degrees.z()*3.141592653589793/180.0*0.5;
    double cx=std::cos(x),sx=std::sin(x),cy=std::cos(y),sy=std::sin(y),cz=std::cos(z),sz=std::sin(z);
    return btQuaternion(sz*cx*sy+cz*sx*cy,cz*cx*sy-sz*sx*cy,sz*cx*cy-cz*sx*sy,sz*sx*sy+cz*cx*cy);
}
extern "C" {
int define_vehicle_named(int key,const float* values,int count){
    if(!values||count!=200||key<0||!ownedVehicles.empty())return 0;
    for(int i=0;i<count;i++)if(!std::isfinite(values[i]))return 0;
    if(values[10]<0||values[10]>8||std::floor(values[10])!=values[10])return 0;
    int wheels=int(values[10]);
    int cursor=11;auto pending=std::make_unique<VehicleDefinition>();
    for(int i=0;i<10;i++)pending->values[i]=values[i];
    if(values[1]<=0||values[7]<0)return 0;
    for(int wheel=0;wheel<wheels;wheel++){
        if(values[cursor]!=0&&values[cursor]!=1)return 0;
        VehicleWheel entry{values[cursor]!=0,btVector3(values[cursor+1],values[cursor+2],values[cursor+3]),values[cursor+4]};
        if(entry.radius<=0)return 0;
        pending->wheels.push_back(entry);cursor+=5;
    }
    if(values[cursor]<1||values[cursor]>10||std::floor(values[cursor])!=values[cursor])return 0;
    int shapes=int(values[cursor++]);
    for(int i=0;i<shapes;i++){
        if(cursor>=count)return 0;
        int type = values[cursor]==1 ? 1 : values[cursor]==2 ? 2 : 0;
        if(!type || cursor+(type==1?10:5)>count)return 0; // Unregistered convex mesh is explicitly unsupported.
        cursor++;
        VehicleBox entry{type,btVector3(values[cursor],values[cursor+1],values[cursor+2]),btVector3(0,0,0),btVector3(0,0,0),0};
        cursor+=3;
        if(type==1){
            entry.extents=btVector3(values[cursor],values[cursor+1],values[cursor+2]);
            entry.rotation=btVector3(values[cursor+3],values[cursor+4],values[cursor+5]);cursor+=6;
            if(entry.extents.x()<=0||entry.extents.y()<=0||entry.extents.z()<=0)return 0;
        }else{entry.radius=values[cursor++];if(entry.radius<=0)return 0;}
        pending->boxes.push_back(entry);
    }
    for(;cursor<count;cursor++)if(values[cursor]!=0)return 0;
    bool selected=vehicleDefinitions.count(key)&&vehicleDefinition==vehicleDefinitions.at(key).get();
    vehicleDefinitions[key]=std::move(pending);if(selected)vehicleDefinition=vehicleDefinitions.at(key).get();return 1;
}
int define_vehicle(const float* values,int count){return define_vehicle_named(0,values,count);}
int vehicle_definition_count(){return vehicleDefinitions.size();}
int select_vehicle_definition(int key){
    auto found=vehicleDefinitions.find(key);if(found==vehicleDefinitions.end())return 0;
    vehicleDefinition=found->second.get();return 1;
}

int add_vehicle(int id,float x,float y,float z,float qx,float qy,float qz,float qw){
    if(!vehicleDefinition && vehicleDefinitions.count(0))vehicleDefinition=vehicleDefinitions.at(0).get();
    if(!ownedWorld||!vehicleDefinition||ownedVehicles.count(id)||id<0)return 0;
    for(float value:{x,y,z,qx,qy,qz,qw})if(!std::isfinite(value))return 0;
    const btQuaternion rotation{double(qx),double(qy),double(qz),double(qw)};
    if(rotation.length2()==0)return 0; // Zero-quaternion native arithmetic is outside this component.
    auto pending=std::make_unique<OwnedVehicle>();pending->id=id;pending->definition=vehicleDefinition;
    // Original 0x180011090 initializes each admitted tire inflation1/present1/removed0.
    for(int index=0;index<int(vehicleDefinition->wheels.size());index++){pending->inflation[index]=1;pending->present[index]=true;}
    pending->compound=std::make_unique<btCompoundShape>(true);
    for(const auto& box:vehicleDefinition->boxes){
        std::unique_ptr<btCollisionShape> shape;
        if(box.type==1)shape=std::make_unique<btBoxShape>(box.extents*0.5);
        else if(box.type==2)shape=std::make_unique<btSphereShape>(box.radius);
        else return 0;
        btTransform transform;transform.setIdentity();transform.setOrigin(box.offset);transform.setRotation(nativeEuler(box.rotation));
        pending->compound->addChildShape(transform,shape.get());pending->shapes.push_back(std::move(shape));
    }
    btTransform transform;transform.setIdentity();transform.setOrigin(btVector3(double(x-float(worldHeader[4])),z,double(y-float(worldHeader[5]))));
    transform.setRotation(rotation); // Original 0x180007c40 uses the same scalar 2/normSquared basis.
    pending->motion=std::make_unique<btDefaultMotionState>(transform);
    btVector3 inertia;pending->compound->calculateLocalInertia(vehicleDefinition->values[1],inertia);
    btRigidBody::btRigidBodyConstructionInfo info(vehicleDefinition->values[1],pending->motion.get(),pending->compound.get(),inertia);
    info.m_friction=4;info.m_rollingFriction=0;info.m_spinningFriction=0;info.m_restitution=0.2; // Native construction-info lacks the newer spinning member.
    pending->body=std::make_unique<btRigidBody>(info);
    // Original vehicle bodies retain physics flags 0; upstream default 8 adds an absent implicit gyroscopic force.
    pending->body->setFlags(0);
    pending->body->setCollisionFlags(pending->body->getCollisionFlags()|8);
    pending->raycaster=std::make_unique<NativeVehicleRaycaster>(&ownedWorld->world);
    btRaycastVehicle::btVehicleTuning tuning;
    pending->vehicle=std::make_unique<btRaycastVehicle>(tuning,pending->body.get(),pending->raycaster.get());
    pending->vehicle->setCoordinateSystem(0,1,2);
    for(int index=0;index<int(vehicleDefinition->wheels.size());index++){
        const auto& input=vehicleDefinition->wheels[index];
        auto& wheel=pending->vehicle->addWheel(input.connection,btVector3(0,-1,0),btVector3(-1,0,0),vehicleDefinition->values[7],input.radius,tuning,input.front);
        wheel.m_suspensionStiffness=vehicleDefinition->values[3];wheel.m_maxSuspensionTravelCm=vehicleDefinition->values[6];
        wheel.m_wheelsDampingRelaxation=vehicleDefinition->values[5];wheel.m_wheelsDampingCompression=vehicleDefinition->values[4];
        wheel.m_frictionSlip=vehicleDefinition->values[8];wheel.m_rollInfluence=vehicleDefinition->values[2];
        if(!input.front)pending->vehicle->setBrake(10000,index);
    }
    // Allocate the registry node before attaching borrowed body/action pointers to Bullet.
    auto inserted=ownedVehicles.emplace(id,std::move(pending));auto& owner=*inserted.first->second;
    ownedWorld->world.addRigidBody(owner.body.get(),2,15);ownedWorld->world.addVehicle(owner.vehicle.get());
    vehicleReadbackValid=false;gContactAddedCallback=nativeContactAdded;ownedWorld->world.setInternalTickCallback(nativeVehiclePreTick,nullptr,true);return 1;
}
int set_vehicle_active(int id,int active){
    auto* ownedVehicle=findVehicle(id);
    if(!ownedVehicle||ownedVehicle->id!=id||(active!=0&&active!=1)||ownedVehicle->isStatic)return 0;
    ownedVehicle->active=active;ownedVehicle->body->forceActivationState(active?DISABLE_DEACTIVATION:ACTIVE_TAG);return 1;
}
int set_vehicle_mass(int id,float mass){
    auto* ownedVehicle=findVehicle(id);
    if(!ownedVehicle||ownedVehicle->id!=id||!std::isfinite(mass)||mass<=0)return 0;
    btVector3 inertia;ownedVehicle->compound->calculateLocalInertia(mass,inertia);
    ownedVehicle->body->setMassProps(mass,inertia);return 1;
}
int set_vehicle_static(int id,int value){
    auto* ownedVehicle=findVehicle(id);
    auto* vehicleDefinition=ownedVehicle?ownedVehicle->definition:nullptr;
    if(!ownedVehicle||ownedVehicle->id!=id||(value!=0&&value!=1))return 0;
    if(ownedVehicle->isStatic==bool(value))return 1;
    bool regionPublished=vehicle_region_published(*ownedVehicle);
    auto& owner=*ownedVehicle;auto& body=*owner.body;
    if(!owner.isStatic)ownedWorld->world.removeVehicle(owner.vehicle.get());
    ownedWorld->world.removeRigidBody(&body);
    double mass=value?0:vehicleDefinition->values[1];btVector3 inertia;
    owner.compound->calculateLocalInertia(mass,inertia);body.setMassProps(mass,inertia);
    if(value){body.setCollisionFlags(body.getCollisionFlags()|btCollisionObject::CF_KINEMATIC_OBJECT);body.forceActivationState(regionPublished?DISABLE_DEACTIVATION:DISABLE_SIMULATION);owner.motion->setWorldTransform(body.getWorldTransform());}
    else{body.setCollisionFlags(body.getCollisionFlags()&~btCollisionObject::CF_KINEMATIC_OBJECT);if(regionPublished)body.setActivationState(ACTIVE_TAG);else body.forceActivationState(DISABLE_SIMULATION);}
    body.setAngularVelocity(btVector3(0,0,0));body.setLinearVelocity(btVector3(0,0,0));body.clearForces();
    owner.isStatic=value;ownedWorld->world.addRigidBody(&body,2,15);
    if(!value)ownedWorld->world.addVehicle(owner.vehicle.get());return 1;
}
int set_tire_inflation(int id,int index,float value){
    auto* ownedVehicle=findVehicle(id);
    auto* vehicleDefinition=ownedVehicle?ownedVehicle->definition:nullptr;
    if(!ownedVehicle||ownedVehicle->id!=id||index<0||index>=int(vehicleDefinition->wheels.size())||!std::isfinite(value))return 0;
    ownedVehicle->inflation[index]=value;return 1;
}
int set_tire_removed(int id,int index,int removed){
    auto* ownedVehicle=findVehicle(id);
    auto* vehicleDefinition=ownedVehicle?ownedVehicle->definition:nullptr;
    if(!ownedVehicle||ownedVehicle->id!=id||index<0||index>=int(vehicleDefinition->wheels.size())||(removed!=0&&removed!=1))return 0;
    auto& owner=*ownedVehicle;owner.removed[index]=removed;auto& wheel=owner.vehicle->getWheelInfo(index);
    wheel.m_wheelsRadius=vehicleDefinition->wheels[index].radius*(removed?0.66:1);
    wheel.m_frictionSlip=removed?0.4:vehicleDefinition->values[8];owner.vehicle->updateWheelTransform(index,false);return 1;
}
int set_vehicle_params(int id,const float* values,int count){
    auto* ownedVehicle=findVehicle(id);
    auto* vehicleDefinition=ownedVehicle?ownedVehicle->definition:nullptr;
    if(!ownedVehicle||ownedVehicle->id!=id||!values||count<int(vehicleDefinition->wheels.size())*6)return 0;
    for(int i=0;i<int(vehicleDefinition->wheels.size())*6;i++)if(!std::isfinite(values[i]))return 0;
    for(int i=0;i<int(vehicleDefinition->wheels.size());i++){
        auto& wheel=ownedVehicle->vehicle->getWheelInfo(i);const auto* input=values+i*6;
        ownedVehicle->inflation[i]=input[1];ownedVehicle->present[i]=input[0]>0.1;
        wheel.m_frictionSlip=input[2];wheel.m_wheelsDampingRelaxation=input[3];wheel.m_wheelsDampingCompression=input[4];
        wheel.m_suspensionRestLength1=double(input[5])+vehicleDefinition->values[7];
        wheel.m_wheelsRadius=vehicleDefinition->wheels[i].radius*(ownedVehicle->present[i]?1:0.66);
        wheel.m_frictionSlip=ownedVehicle->present[i]?vehicleDefinition->values[8]:0.4;
    }return 1;
}
int vehicle_state(double* output){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output)return 0;
    auto& body=*ownedVehicle->body;auto origin=body.getWorldTransform().getOrigin();auto inertia=body.getInvInertiaDiagLocal();
    output[0]=ownedVehicle->id;output[1]=body.getInvMass();
    for(int axis=0;axis<3;axis++){output[2+axis]=origin[axis];output[5+axis]=inertia[axis];}
    output[8]=ownedVehicle->active;output[9]=ownedVehicle->compound->getNumChildShapes();output[10]=ownedVehicle->vehicle->getNumWheels();
    btVector3 min,max;ownedVehicle->compound->getAabb(body.getWorldTransform(),min,max);
    for(int axis=0;axis<3;axis++){output[11+axis]=min[axis];output[14+axis]=max[axis];}
    return 1;
}
int vehicle_basis(double* output,int count){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output||count<9)return 0;
    const auto& basis=ownedVehicle->body->getWorldTransform().getBasis();
    for(int row=0;row<3;row++)for(int column=0;column<3;column++)output[row*3+column]=basis[row][column];
    return 1;
}
int vehicle_child(int index,double* output){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output||index<0||index>=ownedVehicle->compound->getNumChildShapes())return 0;
    const auto& transform=ownedVehicle->compound->getChildTransform(index);
    for(int row=0;row<3;row++){for(int column=0;column<3;column++)output[row*4+column]=transform.getBasis()[row][column];output[row*4+3]=0;output[12+row]=transform.getOrigin()[row];}output[15]=0;
    btVector3 min,max;ownedVehicle->shapes[index]->getAabb(transform,min,max);for(int axis=0;axis<3;axis++){output[16+axis]=min[axis];output[19+axis]=max[axis];}return 1;
}
int vehicle_wheel(int index,double* output){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output||index<0||index>=ownedVehicle->vehicle->getNumWheels())return 0;
    auto& w=ownedVehicle->vehicle->getWheelInfo(index);int cursor=0;
    for(const auto& vector:{w.m_chassisConnectionPointCS,w.m_wheelDirectionCS,w.m_wheelAxleCS})for(int axis=0;axis<3;axis++)output[cursor++]=vector[axis];
    for(double value:{w.m_suspensionRestLength1,w.m_maxSuspensionTravelCm,w.m_wheelsRadius,w.m_suspensionStiffness,w.m_wheelsDampingCompression,w.m_wheelsDampingRelaxation,w.m_frictionSlip,w.m_steering,w.m_rotation,w.m_rollInfluence,w.m_maxSuspensionForce,w.m_engineForce,w.m_brake})output[cursor++]=value;
    output[cursor]=w.m_bIsFrontWheel;return 1;
}
int remove_vehicle(int id){if(!ownedWorld)return 0;auto* owner=findVehicle(id);if(!owner)return 1;ownedWorld->world.removeVehicle(owner->vehicle.get());ownedWorld->world.removeRigidBody(owner->body.get());ownedVehicles.erase(id);vehicleReadbackValid=false;return 1;}
}

extern "C" int clear_registered_vehicle(){
    int result=1;while(!ownedVehicles.empty())if(!remove_vehicle(ownedVehicles.begin()->first)){result=0;break;}
    vehicleReadback.clear();vehicleReadbackValid=false;
    vehicleDefinition=nullptr;
    vehicleDefinitions.clear();
    return result;
}

static int packVehicle(OwnedVehicle& owner,float* output){
    auto& body=*owner.body;auto& vehicle=*owner.vehicle;
    const auto& transform=body.getWorldTransform();auto quaternion=transform.getRotation();auto velocity=body.getLinearVelocity();
    output[0]=float(owner.id)+0.1f;
    for(int axis=0;axis<3;axis++)output[1+axis]=transform.getOrigin()[axis];
    for(int axis=0;axis<4;axis++)output[4+axis]=quaternion[axis];
    for(int axis=0;axis<3;axis++)output[8+axis]=velocity[axis];
    output[11]=vehicle.getCurrentSpeedKmHour();
    output[12]=owner.collisionEvent?1:0;owner.collisionEvent=false;output[13]=float(vehicle.getNumWheels())+0.1f;
    for(int i=0;i<4;i++){
        auto& wheel=vehicle.getWheelInfo(i);int cursor=14+i*4;
        output[cursor]=wheel.m_steering;output[cursor+1]=wheel.m_rotation;
        output[cursor+2]=wheel.m_skidInfo;output[cursor+3]=wheel.m_raycastInfo.m_suspensionLength;
    }return 1;
}
// Isolated real solver/readback closure. Mapped publication callbacks are a separate frontier.
extern "C" int step_vehicle_freefall(float delta){
    auto* ownedVehicle=singleVehicle();
    if(!ownedWorld||!ownedVehicle||!std::isfinite(delta)||delta!=0.01f||ownedVehicle->isStatic)return 0;
    for(const auto& map:activeMaps)if(map)return 0;
    if(!geometryBodies.empty()||ownedWorld->world.getNumCollisionObjects()!=1)return 0;
    ownedWorld->world.stepSimulation(double(delta),0,0);
    ownedVehicle->hasPublishedStep=true;return 1;
}
extern "C" int get_vehicle_physics(float* output,int count){
    auto* ownedVehicle=singleVehicle();
    if(!output||count<30||!ownedVehicle||!ownedVehicle->hasPublishedStep||ownedVehicle->vehicle->getNumWheels()!=4)return 0;
    return packVehicle(*ownedVehicle,output);
}

static std::shared_ptr<Chunk> find_chunk(int x,int y){
    for(const auto& map:activeMaps)if(map){auto chunk=map->at(x,y);if(chunk)return chunk;}return nullptr;
}
static bool vehicle_region_published(const OwnedVehicle& owner){
    auto origin=owner.body->getWorldTransform().getOrigin();
    int x=int(std::floor(origin.x()+worldHeader[4])),y=int(std::floor(origin.z()+worldHeader[5]));
    int level=int(std::floor(origin.y()/2.449490010738373));
    int wx=int(std::floor(float(x)*0.125f)),wy=int(std::floor(float(y)*0.125f));
    for(int dx=-1;dx<=1;dx++)for(int dy=-1;dy<=1;dy++){
        int cx=wx+dx,cy=wy+dy;
        if(cx<worldHeader[0]*32||cy<worldHeader[1]*32||cx>=(worldHeader[2]+1)*32||cy>=(worldHeader[3]+1)*32)continue;
        auto chunk=find_chunk(cx,cy);if(!chunk||level<chunk->minLevel||level>chunk->maxLevel)return false;
        auto& record=*chunk->records[level-chunk->minLevel];if(!record.loaded||!record.published)return false;
    }return true;
}
extern "C" int replace_chunk_level(int wx,int wy,int min,int max,int level,const int* cells){
    auto chunk=find_chunk(wx,wy);
    if(!chunk||!cells||min<0||max>63||min>max||level<min||level>max)return 0;
    for(int i=0;i<256;i++)if(!validCell(cells[i]))return 0;
    for(int square=0;square<64;square++){int stairs=0;for(int slot=0;slot<4;slot++)if(cells[square*4+slot]==8||cells[square*4+slot]==9)stairs++;if(stairs>1)return 0;}
    std::vector<std::unique_ptr<ChunkRecord>> pending(max-min+1);
    for(int z=min;z<=max;z++)if(z<chunk->minLevel||z>chunk->maxLevel)pending[z-min]=std::make_unique<ChunkRecord>(chunk.get());
    for(int z=min;z<=max;z++)if(z>=chunk->minLevel&&z<=chunk->maxLevel)pending[z-min]=std::move(chunk->records[z-chunk->minLevel]);
    // Retire actual bodies belonging to discarded levels or to this replacement.
    for(auto entry=geometryBodies.begin();entry!=geometryBodies.end();){
        auto& body=**entry;
        if(body.chunkX==wx&&body.chunkY==wy&&(body.level<min||body.level>max||body.level==level)){
            removeGeometryBody(body);entry=geometryBodies.erase(entry);
        }else ++entry;
    }
    chunk->minLevel=min;chunk->maxLevel=max;chunk->records=std::move(pending);
    auto& record=*chunk->records[level-min];std::copy(cells,cells+256,record.cells.begin());record.loaded=true;record.published=false;return 1;
}
extern "C" int begin_vehicle_publication(int* output,int capacity){
    if(!ownedWorld||!output||capacity<169*64)return -1;
    int maps=0;for(const auto& map:activeMaps)if(map)maps++;if(maps==0)return 0;if(maps!=1)return -1;
    // Native world-boundary chunks expand to0..63. This component rejects that separate boundary before mutation.
    for(const auto& map:activeMaps)if(map)for(const auto& chunk:map->cells){
        if(chunk->x+1==worldHeader[0]*32||chunk->x==(worldHeader[2]+1)*32||chunk->y+1==worldHeader[1]*32||chunk->y==(worldHeader[3]+1)*32)return -1;
    }
    for(const auto& entry:ownedVehicles){
    auto origin=entry.second->body->getWorldTransform().getOrigin();
    int x=int(std::floor(origin.x()+worldHeader[4])),y=int(std::floor(origin.z()+worldHeader[5]));
    int level=int(std::floor(origin.y()/2.449490010738373));
    int wx=int(std::floor(float(x)*0.125f)),wy=int(std::floor(float(y)*0.125f));
    for(int dx=-1;dx<=1;dx++)for(int dy=-1;dy<=1;dy++)if(auto chunk=find_chunk(wx+dx,wy+dy)){
        for(int z=level-1;z<=level+1;z++)if(z>=chunk->minLevel&&z<=chunk->maxLevel)chunk->records[z-chunk->minLevel]->needed=true;
    }
    }
    int count=0;
    for(const auto& map:activeMaps)if(map)for(const auto& chunk:map->cells)for(int z=chunk->minLevel;z<=chunk->maxLevel;z++){
        if(chunk->records[z-chunk->minLevel]->needed){output[count*3]=chunk->x;output[count*3+1]=chunk->y;output[count*3+2]=z;count++;}
    }return count;
}
extern "C" int finish_vehicle_publication(){
    if(!ownedWorld)return 0;
    for(const auto& map:activeMaps)if(map)for(const auto& chunk:map->cells)for(int z=chunk->minLevel;z<=chunk->maxLevel;z++){
        auto& record=*chunk->records[z-chunk->minLevel];
        if(record.needed&&!record.published){if(!build_geometry(chunk->x,chunk->y,z,record.cells.data()))return 0;record.published=true;}
        if(!record.needed&&record.published){
            for(auto entry=geometryBodies.begin();entry!=geometryBodies.end();){auto& body=**entry;
                if(body.chunkX==chunk->x&&body.chunkY==chunk->y&&body.level==z){removeGeometryBody(body);entry=geometryBodies.erase(entry);}else ++entry;}
            record.published=false;
        }record.needed=false;
    }return 1;
}
extern "C" int step_mapped_vehicle(float delta){
    if(!ownedWorld||!std::isfinite(delta)||delta!=0.01f)return 0;
    ownedWorld->world.stepSimulation(double(delta),0,0);for(auto& entry:ownedVehicles)entry.second->hasPublishedStep=true;return 1;
}
extern "C" int vehicle_control_history(double* output){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output)return 0;
    auto& owner=*ownedVehicle;output[0]=owner.velocityThreshold;output[1]=owner.velocityMultiplier;
    auto linear=owner.body->getLinearVelocity(),angular=owner.body->getAngularVelocity();
    for(int axis=0;axis<3;axis++){output[2+axis]=owner.previousLinear[axis];output[5+axis]=owner.previousAngular[axis];output[8+axis]=linear[axis];output[11+axis]=angular[axis];}
    return 1;
}
extern "C" int chunk_level_state(int wx,int wy,int level,int* output){
    auto chunk=find_chunk(wx,wy);if(!chunk||!output||level<chunk->minLevel||level>chunk->maxLevel)return 0;
    auto& record=*chunk->records[level-chunk->minLevel];output[0]=record.loaded;output[1]=record.published;output[2]=record.needed;
    int count=0;for(const auto& body:geometryBodies)if(body->chunkX==wx&&body->chunkY==wy&&body->level==level)count++;output[3]=count;return 1;
}

static void clear_chunk_geometry(int x,int y){
    for(auto entry=geometryBodies.begin();entry!=geometryBodies.end();){
        if((*entry)->chunkX==x&&(*entry)->chunkY==y){removeGeometryBody(**entry);entry=geometryBodies.erase(entry);}else ++entry;
    }
}
extern "C" int vehicle_material(double* output){
    auto* ownedVehicle=singleVehicle();
    if(!ownedVehicle||!output)return 0;auto& body=*ownedVehicle->body;
    output[0]=body.getFriction();output[1]=body.getRestitution();output[2]=body.getRollingFriction();output[3]=body.getSpinningFriction();output[4]=body.getActivationState();return 1;
}

extern "C" int set_chunk_levels(int wx,int wy,int min,int max){
    auto chunk=find_chunk(wx,wy);if(!chunk||min<0||max>63||min>max)return 0;
    if(chunk->minLevel==min&&chunk->maxLevel==max)return 1;
    std::vector<std::unique_ptr<ChunkRecord>> pending(max-min+1);
    for(int z=min;z<=max;z++)if(z<chunk->minLevel||z>chunk->maxLevel)pending[z-min]=std::make_unique<ChunkRecord>(chunk.get());
    for(int z=min;z<=max;z++)if(z>=chunk->minLevel&&z<=chunk->maxLevel)pending[z-min]=std::move(chunk->records[z-chunk->minLevel]);
    for(auto entry=geometryBodies.begin();entry!=geometryBodies.end();){auto& body=**entry;
        if(body.chunkX==wx&&body.chunkY==wy&&(body.level<min||body.level>max)){removeGeometryBody(body);entry=geometryBodies.erase(entry);}else ++entry;
    }
    chunk->minLevel=min;chunk->maxLevel=max;chunk->records=std::move(pending);return 1;
}
extern "C" int registered_vehicle_count(){return ownedWorld?int(ownedVehicles.size()):-1;}

extern "C" int object_registry_count(){
    if(!ownedWorld)return -1;
    const auto& objects=ownedWorld->world.getCollisionObjectArray();
    for(int i=0;i<objects.size();i++){
        if(vehicleForBody(objects[i]))continue;
        bool geometry=false;for(const auto& body:geometryBodies)if(objects[i]==body->body.get()){geometry=true;break;}
        if(!geometry)return -1; // No other dynamic-object owner has been admitted.
    }return 0;
}

// Read-only observation of existing three ticks; no solver/callback/settings change.
extern "C" int observe_vehicle_contacts(double* output,int capacity){
    auto* ownedVehicle=singleVehicle();
 if(!ownedWorld||!ownedVehicle||!output||capacity<8192)return -1;
 int manifolds=ownedWorld->dispatcher.getNumManifolds();if(manifolds<0||manifolds>64)return -1;
 int cursor=0;auto add=[&](double value){if(!std::isfinite(value)||cursor>=capacity)return false;output[cursor++]=value;return true;};
 auto vec=[&](const btVector3& value){return add(value.x())&&add(value.y())&&add(value.z());};
 auto object=[&](const btCollisionObject* body){return body&&body->getCollisionShape()&&add(body==ownedVehicle->body.get()?1:0)&&add(body->getCollisionShape()->getShapeType())&&vec(body->getWorldTransform().getOrigin());};
 const auto& info=ownedWorld->world.getSolverInfo();
 const auto& bodyBasis=ownedVehicle->body->getWorldTransform().getBasis();
 if(!vec(ownedVehicle->body->getAngularVelocity())||!vec(ownedVehicle->body->getLinearVelocity())||!vec(bodyBasis.getRow(0))||!vec(bodyBasis.getRow(1))||!vec(bodyBasis.getRow(2))||!add(ownedVehicle->body->getFlags())||!add(info.m_solverMode)||!add(info.m_numIterations)||!add(info.m_warmstartingFactor)||!add(info.m_splitImpulse)||!add(info.m_splitImpulsePenetrationThreshold)||!add(info.m_linearSlop)||!add(info.m_erp)||!add(info.m_erp2)||!add(manifolds))return -1;
 for(int index=0;index<manifolds;index++){
  const auto* manifold=ownedWorld->dispatcher.getManifoldByIndexInternal(index);
  if(!manifold||!object(manifold->getBody0())||!object(manifold->getBody1()))return -1;
  int contacts=manifold->getNumContacts();if(contacts<0||contacts>4||!add(contacts))return -1;
  for(int contact=0;contact<contacts;contact++){
   const auto& point=manifold->getContactPoint(contact);
   if(!vec(point.m_localPointA)||!vec(point.m_localPointB)||!vec(point.getPositionWorldOnB())||!vec(point.getPositionWorldOnA())||!vec(point.m_normalWorldOnB)||!add(point.getDistance())||!add(point.m_combinedFriction)||!add(point.getLifeTime())||!add(point.getAppliedImpulse())||!add(point.m_appliedImpulseLateral1)||!add(point.m_appliedImpulseLateral2)||!vec(point.m_lateralFrictionDir1))return -1;
  }
 }
 return cursor;
}

extern "C" int vehicle_count_snapshot(){
    if(!ownedWorld)return -1;
    vehicleReadback.clear();for(const auto& entry:ownedVehicles)vehicleReadback.push_back(entry.first);
    vehicleReadbackValid=true;return vehicleReadback.size();
}
extern "C" int get_vehicle_physics_batch(int offset,float* output,int count){
    if(!ownedWorld||!vehicleReadbackValid||offset<0)return -1;
    if(offset>=int(vehicleReadback.size()))return 0;
    if(!output||count<30)return -1;
    int records=btMin(count/30,int(vehicleReadback.size())-offset);
    for(int index=0;index<records;index++){
        auto* owner=findVehicle(vehicleReadback[offset+index]);
        if(!owner||owner->vehicle->getNumWheels()!=4)return -1;
    }
    for(int index=0;index<records;index++)packVehicle(*findVehicle(vehicleReadback[offset+index]),output+index*30);
    return records;
}
