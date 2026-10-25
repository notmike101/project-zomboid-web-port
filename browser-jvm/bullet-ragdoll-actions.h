// Original ragdoll forces and joint disable operations, using the same owned real Bullet instances.
extern "C" int apply_ragdoll_force(int id,int part,const float* values,int impulse){
    if(!ownedWorld)return 0;auto* owner=findRagdoll(id);if(!owner)return 1;
    if(part<0||part>=11||!values||(impulse!=0&&impulse!=1))return 0;
    for(int i=0;i<6;i++)if(!std::isfinite(values[i]))return 0;
    btVector3 force(values[0],values[1],values[2]),relative(values[3],values[4],values[5]);
    if(impulse)owner->bodies[part]->applyImpulse(force,relative);else owner->bodies[part]->applyForce(force,relative);return 1;
}
extern "C" int detach_ragdoll_constraint(int id,int joint){
    if(!ownedWorld)return 0;auto* owner=findRagdoll(id);if(!owner)return 1;
    if(joint<0||joint>=10)return 0;owner->joints[joint]->setEnabled(false);return 1;
}
extern "C" int ragdoll_action_state(int id,int part,double* output){
    auto* owner=findRagdoll(id);if(!owner||part<0||part>=11||!output)return 0;const auto& body=*owner->bodies[part];
    int cursor=0;for(const auto& vector:{body.getLinearVelocity(),body.getAngularVelocity(),body.getTotalForce(),body.getTotalTorque()})for(int axis=0;axis<3;axis++)output[cursor++]=vector[axis];
    output[12]=body.getActivationState();for(int joint=0;joint<10;joint++)output[13+joint]=owner->joints[joint]->isEnabled()?1:0;return 1;
}

extern "C" int set_ragdoll_local_rotation(int id,float x,float y,float z,float w){
    if(!ownedWorld)return 0;auto* owner=findRagdoll(id);if(!owner)return 1;
    for(float value:{x,y,z,w})if(!std::isfinite(value))return 0;
    btQuaternion rotation(x,y,z,w);if(rotation.length2()==0)return 0;
    owner->localRotation=btTransform(rotation,btVector3(0,0,0));return 1;
}
