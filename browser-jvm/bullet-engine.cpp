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
