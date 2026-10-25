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

// Original 0x180016a70 derives additive impulses in the previous body's local frame.
extern "C" int update_ragdoll_previous_pose(int id,int count,float seconds,const float* records){
    if(!ownedWorld)return 0;auto* owner=findRagdoll(id);if(!owner)return 1;
    if(!owner->anchorsReady||!records||count!=owner->definition->parents.size()||!std::isfinite(seconds)||seconds<=0)return 0;
    std::vector<btTransform> world(count);
    for(int i=0;i<count;i++){
        const float* r=records+i*7;for(int j=0;j<7;j++)if(!std::isfinite(r[j]))return 0;
        btQuaternion rotation(r[3],r[4],r[5],r[6]);if(rotation.length2()==0)return 0;
        btTransform local(rotation,btVector3(r[0],r[1],r[2]));if(i==0)local=local*owner->localRotation;
        world[i]=i==0?local:world[owner->definition->parents[i]]*local;
    }
    for(int part=0;part<11;part++){
        auto& body=*owner->bodies[part];btTransform previous=owner->root*world[owner->anchorBones[part]]*owner->anchorOffsets[part];
        btTransform delta=previous.inverseTimes(body.getWorldTransform());const auto& matrix=delta.getBasis();
        double yaw=std::atan2(matrix[1][0],matrix[0][0]);double pitch=std::asin(std::max(-1.,std::min(1.,-matrix[2][0])));double roll=std::atan2(matrix[2][1],matrix[2][2]);
        if(std::abs(pitch)==1.5707963267948966){yaw+=yaw>0?-3.141592653589793:3.141592653589793;roll+=roll>0?-3.141592653589793:3.141592653589793;}
        body.applyCentralImpulse(delta.getOrigin()/double(seconds));body.applyTorqueImpulse(btVector3(yaw,pitch,roll)/double(seconds));
    }
    return 1;
}
