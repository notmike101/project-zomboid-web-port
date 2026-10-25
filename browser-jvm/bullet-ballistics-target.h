// Original ballistics target ownership: separate no-response aggregate box and detached body controller.
struct OwnedBallisticsTarget {
    std::unique_ptr<OwnedRagdoll> skeleton;
    std::unique_ptr<btBoxShape> shape;
    std::unique_ptr<btCollisionObject> object;
};
static std::map<int,std::unique_ptr<OwnedBallisticsTarget>> ownedBallisticsTargets;
static std::vector<std::unique_ptr<OwnedBallisticsTarget>> pooledBallisticsTargets;
extern "C" int add_ballistics_target(int id,const float* parts,const float* dynamics,const float* joints){
    if(!ownedWorld||id<0)return -1;if(ownedBallisticsTargets.count(id))return 1;
    std::unique_ptr<OwnedBallisticsTarget> pending;
    if(pooledBallisticsTargets.empty()){
        auto skeleton=construct_ragdoll(parts,dynamics,joints,10);if(!skeleton)return -1;
        pending=std::make_unique<OwnedBallisticsTarget>();pending->skeleton=std::move(skeleton);
        pending->shape=std::make_unique<btBoxShape>(btVector3(double(float(.175)),double(float(.81649667)),double(float(.175))));
        pending->object=std::make_unique<btCollisionObject>();pending->object->setCollisionShape(pending->shape.get());pending->object->setCollisionFlags(4);
    }else{pending=std::move(pooledBallisticsTargets.front());pooledBallisticsTargets.erase(pooledBallisticsTargets.begin());}
    pending->object->setUserIndex(id);ownedWorld->world.addCollisionObject(pending->object.get(),16,-1);
    ownedBallisticsTargets.emplace(id,std::move(pending));return 0;
}
extern "C" int remove_ballistics_target(int id){
    if(!ownedWorld)return -1;auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 0;
    ownedWorld->world.removeCollisionObject(found->second->object.get());
    pooledBallisticsTargets.push_back(std::move(found->second));ownedBallisticsTargets.erase(found);return 0;
}
extern "C" int clear_ballistics_targets(){
    if(!ownedWorld)return ownedBallisticsTargets.empty()?1:0;
    while(!ownedBallisticsTargets.empty())if(remove_ballistics_target(ownedBallisticsTargets.begin()->first)!=0)return 0;
    pooledBallisticsTargets.clear();return 1;
}
// Bounded original-DLL comparison of actual ownership, geometry and detached body state.
extern "C" int ballistics_target_state(int id,int part,double* output){
    auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end()||!output||part<0||part>=11)return 0;
    const auto& target=*found->second;const auto& body=*target.skeleton->bodies[part];const auto& transform=body.getWorldTransform();int cursor=0;
    for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=transform.getBasis()[row][col];
    for(int axis=0;axis<3;axis++)output[cursor++]=transform.getOrigin()[axis];
    output[12]=body.getInvMass();output[13]=body.getCollisionFlags();output[14]=body.getActivationState();
    btVector3 lo,hi;target.shape->getAabb(btTransform::getIdentity(),lo,hi);
    for(int axis=0;axis<3;axis++){output[15+axis]=lo[axis];output[18+axis]=hi[axis];}
    output[21]=target.object->getCollisionFlags();output[22]=target.object->getBroadphaseHandle()->m_collisionFilterGroup;output[23]=target.object->getBroadphaseHandle()->m_collisionFilterMask;return 1;
}
