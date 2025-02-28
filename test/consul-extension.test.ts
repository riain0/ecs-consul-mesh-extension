import {
  Container,
  Environment,
  Service,
  ServiceDescription,
} from '@aws-cdk-containers/ecs-service-extensions';
import { aws_ecs as ecs, aws_secretsmanager as secretsmanager, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ECSConsulMeshExtension, RetryJoin } from '../lib/consul-mesh-extension';

describe('consulmesh', () => {
test('Test extension with default params', () => {
  // WHEN
  const stack = new Stack();
  // GIVEN
  const environment = new Environment(stack, 'production');

  const consulSecurityGroup = new ec2.SecurityGroup(stack, 'consulServerSecurityGroup', {
    vpc: environment.vpc
  });

  const consulClientSecurityGroup = new ec2.SecurityGroup(stack, 'consulClientSecurityGroup', {
    vpc: environment.vpc
  });

  const TLSSecret = secretsmanager.Secret.fromSecretNameV2(
    stack,
    'TLSEncryptKey',
    'TLSEncryptValue',
  );

  const gossipEncryptKey = secretsmanager.Secret.fromSecretNameV2(
    stack,
    'gossipEncryptKey',
    'gossipEncryptValue',
  );

  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.tcp(8301),
    "allow all the clients in the mesh talk to each other"
  );
  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.udp(8301),
    "allow all the clients in the mesh talk to each other"
  )

  const nameDescription = new ServiceDescription();
  nameDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/name')
  }));

  nameDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientSecurityGroup,
    tls: true,
    consulCACert: TLSSecret,
    gossipEncryptKey,
    serviceDiscoveryName: "name",
    aclSecretArn: "arn:aws:secretsmanager:us-east-2:1234556789:secret:i-07c446_consulAgentCaCert-NBIwAK",
    healthCheck: {
      command: ["CMD-SHELL", "curl localhost:3000/health"],
      interval: Duration.seconds(30),
      retries: 3,
      timeout: Duration.seconds(5),
    }
  }));

  const nameService = new Service(stack, 'name', {
    environment: environment,
    serviceDescription: nameDescription
  });

  // launch service into that cluster
  const greeterDescription = new ServiceDescription();
  greeterDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/greeter')
  }));

  greeterDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientSecurityGroup,
    tls: true,
    consulCACert: TLSSecret,
    gossipEncryptKey,
    serviceDiscoveryName: "greeter",
    consulChecks: [
      {
        checkid  : "server-http",
        name     : "HTTP health check on port 3000",
        http     : "http://localhost:3000/health",
        method   : "GET",
        timeout  : "10s",
        interval : "2s",
      }
    ]
  }));

  const greeterService = new Service(stack, 'greeter', {
    environment: environment,
    serviceDescription: greeterDescription
  });

  greeterService.connectTo(nameService, { localBindPort: 8080})

  //THEN
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    "ContainerDefinitions": [
      {
        "Cpu": 1024,
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          },
          {
            "Condition": "HEALTHY",
            "ContainerName": "sidecar-proxy"
          }
        ],
        "Environment": [
          {
            "Name": "NAME_URL",
            "Value": "http://localhost:8080"
          }
        ],
        "Essential": true,
        "Image": "nathanpeck/greeter",
        "Memory": 2048,
        "Name": "app",
        "PortMappings": [
          {
            "ContainerPort": 3000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1024000,
            "Name": "nofile",
            "SoftLimit": 1024000
          }
        ]
      },
      {
        "Command": [
          {
            "Fn::Join": [
              "",
              [
                "cp /bin/consul /bin/consul-inject/consul &&\n                ECS_IPV4=$(curl -s $ECS_CONTAINER_METADATA_URI | jq -r '.Networks[0].IPv4Addresses[0]') && if [ true == true ]; then                 echo \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:TLSEncryptValue:SecretString:::}}\" > /tmp/consul-agent-ca-cert.pem;\n                fi &&\n                  exec consul agent                   -advertise $ECS_IPV4                   -data-dir /consul/data                   -client 0.0.0.0                   -datacenter \"dc1\"                   -hcl 'addresses = { dns = \"127.0.0.1\" }'                   -hcl 'addresses = { grpc = \"127.0.0.1\" }'                   -hcl 'addresses = { http = \"127.0.0.1\" }'                   -retry-join \"provider=aws region=us-west-2 tag_key=Name tag_value=test-consul-server\"                   -hcl 'telemetry { disable_compat_1.9 = true }'                   -hcl 'leave_on_terminate = true'                   -hcl 'ports { grpc = 8502 }'                   -hcl 'advertise_reconnect_timeout = \"15m\"'                   -hcl 'enable_central_service_config = true'                -hcl 'ca_file = \"/tmp/consul-agent-ca-cert.pem\"'                -hcl 'auto_encrypt = {tls = true}'                -hcl \"auto_encrypt = {ip_san = [ \\\"$ECS_IPV4\\\" ]}\"                -hcl 'verify_outgoing = true'             -encrypt \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:gossipEncryptValue:SecretString:::}}\""
              ]
            ]
          }
        ],
        "EntryPoint": [
          "/bin/sh",
          "-ec"
        ],
        "Essential": false,
        "Image": "hashicorp/consul:1.10.4",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionconsulclientLogGroup99EB1A03"
            },
            "awslogs-stream-prefix": "consul-client",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/consul/config",
            "ReadOnly": false,
            "SourceVolume": "consul-config"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": false,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-client",
        "PortMappings": [
          {
            "ContainerPort": 8301,
            "Protocol": "tcp"
          },
          {
            "ContainerPort": 8301,
            "Protocol": "udp"
          },
          {
            "ContainerPort": 8500,
            "Protocol": "tcp"
          }
        ]
      },
      {
        "Command": [
          "mesh-init",
          "-envoy-bootstrap-dir=/consul/data",
          "-port=3000",
          "-upstreams=name:8080",
          "-health-sync-containers=",
          "-checks=[{\"checkid\":\"server-http\",\"name\":\"HTTP health check on port 3000\",\"http\":\"http://localhost:3000/health\",\"method\":\"GET\",\"timeout\":\"10s\",\"interval\":\"2s\"}]",
          "-service-name=greeter"
        ],
        "Essential": false,
        "Image": "hashicorp/consul-ecs:0.2.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionconsulecsmeshinitLogGroup614BD5D5"
            },
            "awslogs-stream-prefix": "consul-ecs-mesh-init",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": true,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-ecs-mesh-init"
      },
      {
        "Command": [
          "/bin/sh",
          "-c",
          "envoy --config-path /consul/data/envoy-bootstrap.json"
        ],
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          }
        ],
        "EntryPoint": [
          "/consul/data/consul-ecs",
          "envoy-entrypoint"
        ],
        "Essential": false,
        "HealthCheck": {
          "Command": [
            "CMD",
            "nc",
            "-z",
            "127.0.0.1",
            "20000"
          ],
          "Interval": 30,
          "Retries": 3,
          "Timeout": 5
        },
        "Image": "envoyproxy/envoy-alpine:v1.18.4",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionsidecarproxyLogGroup928001EA"
            },
            "awslogs-stream-prefix": "envoy",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          }
        ],
        "Name": "sidecar-proxy",
        "PortMappings": [
          {
            "ContainerPort": 20000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1048576,
            "Name": "nofile",
            "SoftLimit": 1048576
          }
        ]
      }
    ],
    "Cpu": "1024",
    "ExecutionRoleArn": {
      "Fn::GetAtt": [
        "greetertaskdefinitionExecutionRoleAED0EC79",
        "Arn"
      ]
    },
    "Family": "greetertaskdefinition",
    "Memory": "2048",
    "NetworkMode": "awsvpc",
    "RequiresCompatibilities": [
      "EC2",
      "FARGATE"
    ],
    "TaskRoleArn": {
      "Fn::GetAtt": [
        "greetertaskdefinitionTaskRole2A098ACC",
        "Arn"
      ]
    },
    "Volumes": [
      {
        "Name": "consul-data"
      },
      {
        "Name": "consul-config"
      },
      {
        "Name": "consul_binary"
      }
    ]

  }
  );

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    "ContainerDefinitions": [
      {
        "Cpu": 1024,
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          },
          {
            "Condition": "HEALTHY",
            "ContainerName": "sidecar-proxy"
          }
        ],
        "Essential": true,
        "HealthCheck": {
          "Command": [
            "CMD-SHELL",
            "curl localhost:3000/health"
          ],
          "Interval": 30,
          "Retries": 3,
          "Timeout": 5
        },
        "Image": "nathanpeck/name",
        "Memory": 2048,
        "Name": "app",
        "PortMappings": [
          {
            "ContainerPort": 3000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1024000,
            "Name": "nofile",
            "SoftLimit": 1024000
          }
        ]
      },
      {
        "Command": [
          {
            "Fn::Join": [
              "",
              [
                "cp /bin/consul /bin/consul-inject/consul &&\n                ECS_IPV4=$(curl -s $ECS_CONTAINER_METADATA_URI | jq -r '.Networks[0].IPv4Addresses[0]') && if [ true == true ]; then                 echo \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:TLSEncryptValue:SecretString:::}}\" > /tmp/consul-agent-ca-cert.pem;\n                fi &&\n                  exec consul agent                   -advertise $ECS_IPV4                   -data-dir /consul/data                   -client 0.0.0.0                   -datacenter \"dc1\"                   -hcl 'addresses = { dns = \"127.0.0.1\" }'                   -hcl 'addresses = { grpc = \"127.0.0.1\" }'                   -hcl 'addresses = { http = \"127.0.0.1\" }'                   -retry-join \"provider=aws region=us-west-2 tag_key=Name tag_value=test-consul-server\"                   -hcl 'telemetry { disable_compat_1.9 = true }'                   -hcl 'leave_on_terminate = true'                   -hcl 'ports { grpc = 8502 }'                   -hcl 'advertise_reconnect_timeout = \"15m\"'                   -hcl 'enable_central_service_config = true'                -hcl 'ca_file = \"/tmp/consul-agent-ca-cert.pem\"'                -hcl 'auto_encrypt = {tls = true}'                -hcl \"auto_encrypt = {ip_san = [ \\\"$ECS_IPV4\\\" ]}\"                -hcl 'verify_outgoing = true'             -encrypt \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:gossipEncryptValue:SecretString:::}}\""
              ]
            ]
          }
        ],
        "EntryPoint": [
          "/bin/sh",
          "-ec"
        ],
        "Essential": false,
        "Image": "hashicorp/consul:1.10.4",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionconsulclientLogGroup5C3CC781"
            },
            "awslogs-stream-prefix": "consul-client",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/consul/config",
            "ReadOnly": false,
            "SourceVolume": "consul-config"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": false,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-client",
        "PortMappings": [
          {
            "ContainerPort": 8301,
            "Protocol": "tcp"
          },
          {
            "ContainerPort": 8301,
            "Protocol": "udp"
          },
          {
            "ContainerPort": 8500,
            "Protocol": "tcp"
          }
        ]
      },
      {
        "Command": [
          "mesh-init",
          "-envoy-bootstrap-dir=/consul/data",
          "-port=3000",
          "-upstreams=",
          "-health-sync-containers=app",
          "-checks=",
          "-service-name=name"
        ],
        "Essential": false,
        "Image": "hashicorp/consul-ecs:0.2.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionconsulecsmeshinitLogGroupBE13525A"
            },
            "awslogs-stream-prefix": "consul-ecs-mesh-init",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": true,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-ecs-mesh-init"
      },
      {
        "Command": [
          "/bin/sh",
          "-c",
          "envoy --config-path /consul/data/envoy-bootstrap.json"
        ],
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          }
        ],
        "EntryPoint": [
          "/consul/data/consul-ecs",
          "envoy-entrypoint"
        ],
        "Essential": false,
        "HealthCheck": {
          "Command": [
            "CMD",
            "nc",
            "-z",
            "127.0.0.1",
            "20000"
          ],
          "Interval": 30,
          "Retries": 3,
          "Timeout": 5
        },
        "Image": "envoyproxy/envoy-alpine:v1.18.4",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionsidecarproxyLogGroup1F5889C2"
            },
            "awslogs-stream-prefix": "envoy",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          }
        ],
        "Name": "sidecar-proxy",
        "PortMappings": [
          {
            "ContainerPort": 20000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1048576,
            "Name": "nofile",
            "SoftLimit": 1048576
          }
        ]
      },
      {
        "Command": [
          "health-sync",
          "-health-sync-containers=app",
          "-service-name=name"
        ],
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          }
        ],
        "Essential": false,
        "Image": "hashicorp/consul-ecs:0.2.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionconsulecshealthsyncLogGroup7DFDAAAC"
            },
            "awslogs-stream-prefix": "consul-ecs-health-sync",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "Name": "consul-ecs-health-sync",
        "Secrets": [
          {
            "Name": "CONSUL_HTTP_TOKEN",
            "ValueFrom": "arn:aws:secretsmanager:us-east-2:1234556789:secret:i-07c446_consulAgentCaCert-NBIwAK"
          }
        ]
      }
    ],
    "Cpu": "1024",
    "ExecutionRoleArn": {
      "Fn::GetAtt": [
        "nametaskdefinitionExecutionRole45AC5C9A",
        "Arn"
      ]
    },
    "Family": "nametaskdefinition",
    "Memory": "2048",
    "NetworkMode": "awsvpc",
    "RequiresCompatibilities": [
      "EC2",
      "FARGATE"
    ],
    "TaskRoleArn": {
      "Fn::GetAtt": [
        "nametaskdefinitionTaskRole50FE844E",
        "Arn"
      ]
    },
    "Volumes": [
      {
        "Name": "consul-data"
      },
      {
        "Name": "consul-config"
      },
      {
        "Name": "consul_binary"
      }
    ]

  }
  );

  template.hasResourceProperties('AWS::ECS::Service', {
      "Cluster": {
        "Ref": "productionenvironmentclusterC6599D2D"
      },
      "DeploymentConfiguration": {
        "MaximumPercent": 200,
        "MinimumHealthyPercent": 100
      },
      "DesiredCount": 1,
      "EnableECSManagedTags": false,
      "LaunchType": "FARGATE",
      "NetworkConfiguration": {
        "AwsvpcConfiguration": {
          "AssignPublicIp": "DISABLED",
          "SecurityGroups": [
            {
              "Fn::GetAtt": [
                "nameserviceSecurityGroup33F4662C",
                "GroupId"
              ]
            },
            {
              "Fn::GetAtt": [
                "consulClientSecurityGroup279D3373",
                "GroupId"
              ]
            }
          ],
          "Subnets": [
            {
              "Ref": "productionenvironmentvpcPrivateSubnet1Subnet53F632E6"
            },
            {
              "Ref": "productionenvironmentvpcPrivateSubnet2Subnet756FB93C"
            }
          ]
        }
      },
      "TaskDefinition": {
        "Ref": "nametaskdefinition690762BB"
      } 
  });
  
  template.hasResourceProperties('AWS::ECS::Service', {
    "Cluster": {
      "Ref": "productionenvironmentclusterC6599D2D"
    },
    "DeploymentConfiguration": {
      "MaximumPercent": 200,
      "MinimumHealthyPercent": 100
    },
    "DesiredCount": 1,
    "EnableECSManagedTags": false,
    "LaunchType": "FARGATE",
    "NetworkConfiguration": {
      "AwsvpcConfiguration": {
        "AssignPublicIp": "DISABLED",
        "SecurityGroups": [
          {
            "Fn::GetAtt": [
              "greeterserviceSecurityGroupDB4AC3A9",
              "GroupId"
            ]
          },
          {
            "Fn::GetAtt": [
              "consulClientSecurityGroup279D3373",
              "GroupId"
            ]
          }
        ],
        "Subnets": [
          {
            "Ref": "productionenvironmentvpcPrivateSubnet1Subnet53F632E6"
          },
          {
            "Ref": "productionenvironmentvpcPrivateSubnet2Subnet756FB93C"
          }
        ]
      }
    },
    "TaskDefinition": {
      "Ref": "greetertaskdefinitionE956EEA2"
    }
  }); 
});


test('Test extension with custom params', () => {
  // WHEN
  const stack = new Stack();
  // GIVEN
  const environment = new Environment(stack, 'production');

  const consulSecurityGroup = new ec2.SecurityGroup(stack, 'consulServerSecurityGroup', {
    vpc: environment.vpc
  });

  const consulClientSecurityGroup = new ec2.SecurityGroup(stack, 'consulClientSecurityGroup', {
    vpc: environment.vpc
  });

  const TLSSecret = secretsmanager.Secret.fromSecretNameV2(
    stack,
    'TLSEncryptKey',
    'TLSEncryptValue',
  );

  const gossipEncryptKey = secretsmanager.Secret.fromSecretNameV2(
    stack,
    'gossipEncryptKey',
    'gossipEncryptValue',
  );

  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.tcp(8301),
    "allow all the clients in the mesh talk to each other"
  );
  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.udp(8301),
    "allow all the clients in the mesh talk to each other"
  )

  const nameDescription = new ServiceDescription();
  nameDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/name')
  }));

  nameDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientImage: "myCustomConsulClientImage:1.0",
    consulEcsImage: "myCustomConsulEcsImage:1.0",
    envoyProxyImage: "myCustomEnvoyImage:1.0",
    consulClientSecurityGroup,
    tls: true,
    consulCACert: TLSSecret,
    gossipEncryptKey,
    serviceDiscoveryName: "name"
  }));

  const nameService = new Service(stack, 'name', {
    environment: environment,
    serviceDescription: nameDescription
  });

  // launch service into that cluster
  const greeterDescription = new ServiceDescription();
  greeterDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/greeter')
  }));

  greeterDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientImage: "myCustomConsulClientImage:1.0",
    consulEcsImage: "myCustomConsulEcsImage:1.0",
    envoyProxyImage: "myCustomEnvoyImage:1.0",
    consulClientSecurityGroup,
    tls: true,
    consulCACert: TLSSecret,
    gossipEncryptKey,
    serviceDiscoveryName: "greeter"
  }));

  const greeterService = new Service(stack, 'greeter', {
    environment: environment,
    serviceDescription: greeterDescription,
  });

  greeterService.connectTo(nameService);

  //THEN
  const template = Template.fromStack(stack)
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    "ContainerDefinitions": [
      {
        "Cpu": 1024,
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          },
          {
            "Condition": "HEALTHY",
            "ContainerName": "sidecar-proxy"
          }
        ],
        "Environment": [
          {
            "Name": "NAME_URL",
            "Value": "http://localhost:3001"
          }
        ],
        "Essential": true,
        "Image": "nathanpeck/greeter",
        "Memory": 2048,
        "Name": "app",
        "PortMappings": [
          {
            "ContainerPort": 3000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1024000,
            "Name": "nofile",
            "SoftLimit": 1024000
          }
        ]
      },
      {
        "Command": [
          {
            "Fn::Join": [
              "",
              [
                "cp /bin/consul /bin/consul-inject/consul &&\n                ECS_IPV4=$(curl -s $ECS_CONTAINER_METADATA_URI | jq -r '.Networks[0].IPv4Addresses[0]') && if [ true == true ]; then                 echo \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:TLSEncryptValue:SecretString:::}}\" > /tmp/consul-agent-ca-cert.pem;\n                fi &&\n                  exec consul agent                   -advertise $ECS_IPV4                   -data-dir /consul/data                   -client 0.0.0.0                   -datacenter \"dc1\"                   -hcl 'addresses = { dns = \"127.0.0.1\" }'                   -hcl 'addresses = { grpc = \"127.0.0.1\" }'                   -hcl 'addresses = { http = \"127.0.0.1\" }'                   -retry-join \"provider=aws region=us-west-2 tag_key=Name tag_value=test-consul-server\"                   -hcl 'telemetry { disable_compat_1.9 = true }'                   -hcl 'leave_on_terminate = true'                   -hcl 'ports { grpc = 8502 }'                   -hcl 'advertise_reconnect_timeout = \"15m\"'                   -hcl 'enable_central_service_config = true'                -hcl 'ca_file = \"/tmp/consul-agent-ca-cert.pem\"'                -hcl 'auto_encrypt = {tls = true}'                -hcl \"auto_encrypt = {ip_san = [ \\\"$ECS_IPV4\\\" ]}\"                -hcl 'verify_outgoing = true'             -encrypt \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:gossipEncryptValue:SecretString:::}}\""
              ]
            ]
          }
        ],
        "EntryPoint": [
          "/bin/sh",
          "-ec"
        ],
        "Essential": false,
        "Image": "myCustomConsulClientImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionconsulclientLogGroup99EB1A03"
            },
            "awslogs-stream-prefix": "consul-client",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/consul/config",
            "ReadOnly": false,
            "SourceVolume": "consul-config"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": false,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-client",
        "PortMappings": [
          {
            "ContainerPort": 8301,
            "Protocol": "tcp"
          },
          {
            "ContainerPort": 8301,
            "Protocol": "udp"
          },
          {
            "ContainerPort": 8500,
            "Protocol": "tcp"
          }
        ]
      },
      {
        "Command": [
          "mesh-init",
          "-envoy-bootstrap-dir=/consul/data",
          "-port=3000",
          "-upstreams=name:3001",
          "-health-sync-containers=",
          "-checks=",
          "-service-name=greeter"
        ],
        "Essential": false,
        "Image": "myCustomConsulEcsImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionconsulecsmeshinitLogGroup614BD5D5"
            },
            "awslogs-stream-prefix": "consul-ecs-mesh-init",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": true,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-ecs-mesh-init"
      },
      {
        "Command": [
          "/bin/sh",
          "-c",
          "envoy --config-path /consul/data/envoy-bootstrap.json"
        ],
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          }
        ],
        "EntryPoint": [
          "/consul/data/consul-ecs",
          "envoy-entrypoint"
        ],
        "Essential": false,
        "HealthCheck": {
          "Command": [
            "CMD",
            "nc",
            "-z",
            "127.0.0.1",
            "20000"
          ],
          "Interval": 30,
          "Retries": 3,
          "Timeout": 5
        },
        "Image": "myCustomEnvoyImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "greetertaskdefinitionsidecarproxyLogGroup928001EA"
            },
            "awslogs-stream-prefix": "envoy",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          }
        ],
        "Name": "sidecar-proxy",
        "PortMappings": [
          {
            "ContainerPort": 20000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1048576,
            "Name": "nofile",
            "SoftLimit": 1048576
          }
        ]
      }
    ],
    "Cpu": "1024",
    "ExecutionRoleArn": {
      "Fn::GetAtt": [
        "greetertaskdefinitionExecutionRoleAED0EC79",
        "Arn"
      ]
    },
    "Family": "greetertaskdefinition",
    "Memory": "2048",
    "NetworkMode": "awsvpc",
    "RequiresCompatibilities": [
      "EC2",
      "FARGATE"
    ],
    "TaskRoleArn": {
      "Fn::GetAtt": [
        "greetertaskdefinitionTaskRole2A098ACC",
        "Arn"
      ]
    },
    "Volumes": [
      {
        "Name": "consul-data"
      },
      {
        "Name": "consul-config"
      },
      {
        "Name": "consul_binary"
      }
    ]
  }
  );

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    "ContainerDefinitions": [
      {
        "Cpu": 1024,
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          },
          {
            "Condition": "HEALTHY",
            "ContainerName": "sidecar-proxy"
          }
        ],
        "Essential": true,
        "Image": "nathanpeck/name",
        "Memory": 2048,
        "Name": "app",
        "PortMappings": [
          {
            "ContainerPort": 3000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1024000,
            "Name": "nofile",
            "SoftLimit": 1024000
          }
        ]
      },
      {
        "Command": [
          {
            "Fn::Join": [
              "",
              [
                "cp /bin/consul /bin/consul-inject/consul &&\n                ECS_IPV4=$(curl -s $ECS_CONTAINER_METADATA_URI | jq -r '.Networks[0].IPv4Addresses[0]') && if [ true == true ]; then                 echo \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:TLSEncryptValue:SecretString:::}}\" > /tmp/consul-agent-ca-cert.pem;\n                fi &&\n                  exec consul agent                   -advertise $ECS_IPV4                   -data-dir /consul/data                   -client 0.0.0.0                   -datacenter \"dc1\"                   -hcl 'addresses = { dns = \"127.0.0.1\" }'                   -hcl 'addresses = { grpc = \"127.0.0.1\" }'                   -hcl 'addresses = { http = \"127.0.0.1\" }'                   -retry-join \"provider=aws region=us-west-2 tag_key=Name tag_value=test-consul-server\"                   -hcl 'telemetry { disable_compat_1.9 = true }'                   -hcl 'leave_on_terminate = true'                   -hcl 'ports { grpc = 8502 }'                   -hcl 'advertise_reconnect_timeout = \"15m\"'                   -hcl 'enable_central_service_config = true'                -hcl 'ca_file = \"/tmp/consul-agent-ca-cert.pem\"'                -hcl 'auto_encrypt = {tls = true}'                -hcl \"auto_encrypt = {ip_san = [ \\\"$ECS_IPV4\\\" ]}\"                -hcl 'verify_outgoing = true'             -encrypt \"{{resolve:secretsmanager:arn:",
                {
                  "Ref": "AWS::Partition"
                },
                ":secretsmanager:",
                {
                  "Ref": "AWS::Region"
                },
                ":",
                {
                  "Ref": "AWS::AccountId"
                },
                ":secret:gossipEncryptValue:SecretString:::}}\""
              ]
            ]
          }
        ],
        "EntryPoint": [
          "/bin/sh",
          "-ec"
        ],
        "Essential": false,
        "Image": "myCustomConsulClientImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionconsulclientLogGroup5C3CC781"
            },
            "awslogs-stream-prefix": "consul-client",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/consul/config",
            "ReadOnly": false,
            "SourceVolume": "consul-config"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": false,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-client",
        "PortMappings": [
          {
            "ContainerPort": 8301,
            "Protocol": "tcp"
          },
          {
            "ContainerPort": 8301,
            "Protocol": "udp"
          },
          {
            "ContainerPort": 8500,
            "Protocol": "tcp"
          }
        ]
      },
      {
        "Command": [
          "mesh-init",
          "-envoy-bootstrap-dir=/consul/data",
          "-port=3000",
          "-upstreams=",
          "-health-sync-containers=",
          "-checks=",
          "-service-name=name"
        ],
        "Essential": false,
        "Image": "myCustomConsulEcsImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionconsulecsmeshinitLogGroupBE13525A"
            },
            "awslogs-stream-prefix": "consul-ecs-mesh-init",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          },
          {
            "ContainerPath": "/bin/consul-inject",
            "ReadOnly": true,
            "SourceVolume": "consul_binary"
          }
        ],
        "Name": "consul-ecs-mesh-init"
      },
      {
        "Command": [
          "/bin/sh",
          "-c",
          "envoy --config-path /consul/data/envoy-bootstrap.json"
        ],
        "DependsOn": [
          {
            "Condition": "SUCCESS",
            "ContainerName": "consul-ecs-mesh-init"
          }
        ],
        "EntryPoint": [
          "/consul/data/consul-ecs",
          "envoy-entrypoint"
        ],
        "Essential": false,
        "HealthCheck": {
          "Command": [
            "CMD",
            "nc",
            "-z",
            "127.0.0.1",
            "20000"
          ],
          "Interval": 30,
          "Retries": 3,
          "Timeout": 5
        },
        "Image": "myCustomEnvoyImage:1.0",
        "LogConfiguration": {
          "LogDriver": "awslogs",
          "Options": {
            "awslogs-group": {
              "Ref": "nametaskdefinitionsidecarproxyLogGroup1F5889C2"
            },
            "awslogs-stream-prefix": "envoy",
            "awslogs-region": {
              "Ref": "AWS::Region"
            }
          }
        },
        "Memory": 256,
        "MountPoints": [
          {
            "ContainerPath": "/consul/data",
            "ReadOnly": false,
            "SourceVolume": "consul-data"
          }
        ],
        "Name": "sidecar-proxy",
        "PortMappings": [
          {
            "ContainerPort": 20000,
            "Protocol": "tcp"
          }
        ],
        "Ulimits": [
          {
            "HardLimit": 1048576,
            "Name": "nofile",
            "SoftLimit": 1048576
          }
        ]
      }
    ],
    "Cpu": "1024",
    "ExecutionRoleArn": {
      "Fn::GetAtt": [
        "nametaskdefinitionExecutionRole45AC5C9A",
        "Arn"
      ]
    },
    "Family": "nametaskdefinition",
    "Memory": "2048",
    "NetworkMode": "awsvpc",
    "RequiresCompatibilities": [
      "EC2",
      "FARGATE"
    ],
    "TaskRoleArn": {
      "Fn::GetAtt": [
        "nametaskdefinitionTaskRole50FE844E",
        "Arn"
      ]
    },
    "Volumes": [
      {
        "Name": "consul-data"
      },
      {
        "Name": "consul-config"
      },
      {
        "Name": "consul_binary"
      }
    ]

  }
  );
  template.hasResourceProperties('AWS::ECS::Service', {
    "Cluster": {
      "Ref": "productionenvironmentclusterC6599D2D"
    },
    "DeploymentConfiguration": {
      "MaximumPercent": 200,
      "MinimumHealthyPercent": 100
    },
    "DesiredCount": 1,
    "EnableECSManagedTags": false,
    "LaunchType": "FARGATE",
    "NetworkConfiguration": {
      "AwsvpcConfiguration": {
        "AssignPublicIp": "DISABLED",
        "SecurityGroups": [
          {
            "Fn::GetAtt": [
              "nameserviceSecurityGroup33F4662C",
              "GroupId"
            ]
          },
          {
            "Fn::GetAtt": [
              "consulClientSecurityGroup279D3373",
              "GroupId"
            ]
          }
        ],
        "Subnets": [
          {
            "Ref": "productionenvironmentvpcPrivateSubnet1Subnet53F632E6"
          },
          {
            "Ref": "productionenvironmentvpcPrivateSubnet2Subnet756FB93C"
          }
        ]
      }
    },
    "TaskDefinition": {
      "Ref": "nametaskdefinition690762BB"
    } 
});

template.hasResourceProperties('AWS::ECS::Service', {
  "Cluster": {
    "Ref": "productionenvironmentclusterC6599D2D"
  },
  "DeploymentConfiguration": {
    "MaximumPercent": 200,
    "MinimumHealthyPercent": 100
  },
  "DesiredCount": 1,
  "EnableECSManagedTags": false,
  "LaunchType": "FARGATE",
  "NetworkConfiguration": {
    "AwsvpcConfiguration": {
      "AssignPublicIp": "DISABLED",
      "SecurityGroups": [
        {
          "Fn::GetAtt": [
            "greeterserviceSecurityGroupDB4AC3A9",
            "GroupId"
          ]
        },
        {
          "Fn::GetAtt": [
            "consulClientSecurityGroup279D3373",
            "GroupId"
          ]
        }
      ],
      "Subnets": [
        {
          "Ref": "productionenvironmentvpcPrivateSubnet1Subnet53F632E6"
        },
        {
          "Ref": "productionenvironmentvpcPrivateSubnet2Subnet756FB93C"
        }
      ]
    }
  },
  "TaskDefinition": {
    "Ref": "greetertaskdefinitionE956EEA2"
  }
});
});


test('should detect when attempting to connect services from two different envs', () => {
 // GIVEN
const stack = new Stack();

// WHEN
const production = new Environment(stack, 'production');
const development = new Environment(stack, 'development');

  const consulSecurityGroup = new ec2.SecurityGroup(stack, 'consulServerSecurityGroup', {
    vpc: production.vpc
  });

  const consulClientSecurityGroup = new ec2.SecurityGroup(stack, 'consulClientSecurityGroup', {
    vpc: production.vpc
  });

  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.tcp(8301),
    "allow all the clients in the mesh talk to each other"
  );
  consulClientSecurityGroup.addIngressRule(
    consulClientSecurityGroup,
    ec2.Port.udp(8301),
    "allow all the clients in the mesh talk to each other"
  )

  const nameDescription = new ServiceDescription();
  nameDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/name')
  }));

  nameDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientImage: "myCustomConsulClientImage:1.0",
    consulEcsImage: "myCustomConsulEcsImage:1.0",
    envoyProxyImage: "myCustomEnvoyImage:1.0",
    consulClientSecurityGroup,
    serviceDiscoveryName: "name"
  }));

  const nameService = new Service(stack, 'name', {
    environment: development,
    serviceDescription: nameDescription
  });

  // launch service into that cluster
  const greeterDescription = new ServiceDescription();
  greeterDescription.add(new Container({
    cpu: 1024,
    memoryMiB: 2048,
    trafficPort: 3000,
    image: ecs.ContainerImage.fromRegistry('nathanpeck/greeter')
  }));

  greeterDescription.add(new ECSConsulMeshExtension({
    retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
    consulServerSecurityGroup: consulSecurityGroup,
    consulClientImage: "myCustomConsulClientImage:1.0",
    consulEcsImage: "myCustomConsulEcsImage:1.0",
    envoyProxyImage: "myCustomEnvoyImage:1.0",
    consulClientSecurityGroup,
    serviceDiscoveryName: "greeter"
  }));

  const greeterService = new Service(stack, 'greeter', {
    environment: production,
    serviceDescription: greeterDescription,
  });

  // THEN
  expect(() => {
    greeterService.connectTo(nameService);
  }).toThrow("Unable to connect services from different environments");

});

test('should detect when attempting to define both consul checks and ECS health checks', () => {
  // GIVEN
 const stack = new Stack();
 
 // WHEN
 const test = new Environment(stack, 'test');
 
   const consulSecurityGroup = new ec2.SecurityGroup(stack, 'consulServerSecurityGroup', {
     vpc: test.vpc
   });
 
   const consulClientSecurityGroup = new ec2.SecurityGroup(stack, 'consulClientSecurityGroup', {
     vpc: test.vpc
   });
 
   consulClientSecurityGroup.addIngressRule(
     consulClientSecurityGroup,
     ec2.Port.tcp(8301),
     "allow all the clients in the mesh talk to each other"
   );
   consulClientSecurityGroup.addIngressRule(
     consulClientSecurityGroup,
     ec2.Port.udp(8301),
     "allow all the clients in the mesh talk to each other"
   )
 
   const nameDescription = new ServiceDescription();
   nameDescription.add(new Container({
     cpu: 1024,
     memoryMiB: 2048,
     trafficPort: 3000,
     image: ecs.ContainerImage.fromRegistry('nathanpeck/name')
   }));
 
   nameDescription.add(new ECSConsulMeshExtension({
     retryJoin: new RetryJoin({ region: "us-west-2", tagName: "Name", tagValue: "test-consul-server" }),
     consulServerSecurityGroup: consulSecurityGroup,
     consulClientImage: "myCustomConsulClientImage:1.0",
     consulEcsImage: "myCustomConsulEcsImage:1.0",
     envoyProxyImage: "myCustomEnvoyImage:1.0",
     consulClientSecurityGroup,
     serviceDiscoveryName: "name",
     healthCheck: {
        command: ["CMD-SHELL", "curl localhost:3000/health"],
        interval: Duration.seconds(30),
        retries: 3,
        timeout: Duration.seconds(5),
     }, 
     consulChecks: [
      {
          checkid  : "server-http",
          name     : "HTTP health check on port 3000",
          http     : "http://localhost:3000/health",
          method   : "GET",
          timeout  : "10s",
          interval : "2s",
      } 
     ]
   }));
 
   // THEN
   expect( () => {
      new Service(stack, 'name', {
        environment: test,
        serviceDescription: nameDescription
      })
   }
  ).toThrow("Cannot define both Consul Native Checks and ECS Health Checks");
 });

});