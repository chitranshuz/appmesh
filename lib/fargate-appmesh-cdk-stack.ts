import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import logs = require('@aws-cdk/aws-logs');
import iam = require('@aws-cdk/aws-iam');
import appmesh = require('@aws-cdk/aws-appmesh');

export class FargateAppmeshCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Service Discovery private DNS NameSpace
    //creating constants - used as DNS name in CloudMap
    const privateDomainName = "colordemo.local"
    const meshName = "colormesh"

    // The code that defines your stack goes here
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: "/cdk/fargate",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    const healthCheckDefault = {
      "port": 'traffic-port',
      "path": '/ping',
      "interval": cdk.Duration.seconds(30),
      "timeouts": cdk.Duration.seconds(5),
      "healthyThresholdCount": 5,
      "unhealthyThresholdCount": 2,
      "healthyHttpCodes": "200,301,302"
    }

    //new vpc
    //Creating VPC in perticular region with CIDR block
    const vpc = new ec2.Vpc(this, 'CDK-Fargate-VPC', {
      cidr: '10.88.0.0/16',
      maxAzs: 3
    });

    //sg for colortellers tasks
    const colortellerSecurityGroup = new ec2.SecurityGroup(this, "colortellerSecurityGroup", {
      allowAllOutbound: true,
      securityGroupName: 'colortellerSecurityGroup',
      vpc: vpc
    })
    colortellerSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(9080))
    colortellerSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(2701))
    colortellerSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(9901))
    colortellerSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(15000))
    colortellerSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(15001))

    //create a new mesh before we deploy any services on Fargate
    const colormesh = new appmesh.CfnMesh(this, 'color-appmesh', {
      meshName: meshName
    })

    const vnListener = {
      portMapping: {
        port: 9080,
        protocol: 'http'
      },
      healthCheck: {
        healthyThreshold: 2,
        intervalMillis: 5000, // min
        path: '/ping',
        port: 9080,
        protocol: 'http',
        timeoutMillis: 2000,
        unhealthyThreshold: 2
      }
    }
    
    //Creating virtual nodes inside AppMesh
    //virtual node represent actual service running in ECS fargate
    //we have four nodes white, black, blue, red. 
    //using cloud map as service discovery method DNS name (colordemo.local)
    const virtualNodes = ["colorteller-white", "colorteller-black", "colorteller-blue", "colorteller-red"]
    let virtualNode = new Array();;
    for (var v = 0; v < virtualNodes.length; v++) {
      let virtualNodeHostName = (virtualNodes[v] == "colorteller-white") ? "colorteller." + privateDomainName : virtualNodes[v] + '.' + privateDomainName
      virtualNode[v] = new appmesh.CfnVirtualNode(this, "vn" + virtualNodes[v], {
        meshName: meshName,
        virtualNodeName: virtualNodes[v] + '-vn',
        spec: {
          listeners: [vnListener],
          serviceDiscovery: {
            dns: {
              hostname: virtualNodeHostName
            }
          }
        }
      })
      virtualNode[v].addDependsOn(colormesh)
    }
    
    //Virtual Route
    //creating virtual route that have rules for routing(next block)  
    const colortellerVirtualRouter = new appmesh.CfnVirtualRouter(this, "vr-colorteller", {
      virtualRouterName: "colorteller-vr",
      meshName: meshName,
      spec: {
        listeners: [{
          portMapping: {
            port: 9080,
            protocol: 'http'
          }
        }]
      }
    })
    colortellerVirtualRouter.addDependsOn(colormesh)

    //route actually points towards the virtual nodes
    //In this block it points towards colorteller-blue-vn with weigth-1, meaning all traffic route towards to this virtual node
    const route = new appmesh.CfnRoute(this, 'route-colorteller', {
      meshName: meshName,
      virtualRouterName: "colorteller-vr",
      routeName: "colorteller-route",
      spec: {
        httpRoute: {
          action: {
            weightedTargets: [{
              virtualNode: "colorteller-blue-vn",
              weight: 1
            }
          ],
          },
          match: {
            prefix: '/'
          }
        }
      }
    })
    route.addDependsOn(colortellerVirtualRouter)
    for (var v = 0; v < virtualNode.length; v++) {
      route.addDependsOn(virtualNode[v]);
    }

    //virtual service
    //name of virtual service is actual DNS name of your service in our case its DNS name of white virtual node
    new appmesh.CfnVirtualService(this, 'vs-colorteller', {
      meshName: meshName,
      virtualServiceName: 'colorteller.' + privateDomainName,
      spec: {
        provider: {
          virtualRouter: { virtualRouterName: "colorteller-vr" }
        }
      }
    }).addDependsOn(colortellerVirtualRouter)

    //gateway virtual 
    //node which point or take virtual service as backend meaning it point to the virtual service 
    new appmesh.CfnVirtualNode(this, "vn-colorgateway", {
      meshName: meshName,
      virtualNodeName: "colorgateway-vn",
      spec: {
        listeners: [{
          portMapping: {
            port: 9080,
            protocol: 'http'
          }
        }],
        serviceDiscovery: {
          dns: {
            hostname: "colorgateway." + privateDomainName
          }
        },
        backends: [{
          virtualService: {
            virtualServiceName: "colorteller." + privateDomainName
          }
          }
        ]
      }
    }).addDependsOn(colormesh)


    // Fargate Cluster
    const fgCluster = new ecs.Cluster(this, 'fgappMeshCluster', {
      vpc: vpc
    })

    //add private domain to Fargate cluster
    fgCluster.addDefaultCloudMapNamespace({
      name: privateDomainName
    })

     // task iam role
         const taskIAMRole = new iam.Role(this, 'fgAppMeshDemoTaskExecutionRole', {
           assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
           inlinePolicies: {
             'XrayPut':
               new iam.PolicyDocument({
                 statements: [ new iam.PolicyStatement({
                   effect: iam.Effect.ALLOW,
                   resources: [ '*' ],
                   actions: [ 'xray:PutTraceSegments' ]
                 })]
               })
          }
      })
                                                                                                                        
                                                                                                                        
    //color gateway task definition
    const colorgatewayTaskDefinition = new ecs.FargateTaskDefinition(this, 'colorgateway-task-definition', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: taskIAMRole
    });
    
    //creating container for gateway task 
    //using image kopi/colorgateway:latest
    const colorgatwayContainer = colorgatewayTaskDefinition.addContainer('colorgateway', {
      image: ecs.ContainerImage.fromRegistry('kopi/colorgateway:latest'),
      environment: {
        'COLOR_TELLER_ENDPOINT': 'colorteller.' + privateDomainName + ':9080',
        'SERVER_PORT': '9080',
        'TCP_ECHO_ENDPOINT': 'tcpecho.' + privateDomainName + ':2701'
      },
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: "colorgateway-"
      })
    })
    colorgatwayContainer.addPortMappings({
      containerPort: 9080
    })

    //envoy container for gatewy task 
    //using image kopi/appmesh:latest
    const envoyContainer = colorgatewayTaskDefinition.addContainer('envoy', {
      image: ecs.ContainerImage.fromRegistry('kopi/appmesh:latest'),
      environment: {
        'APPMESH_VIRTUAL_NODE_NAME': 'mesh/' + meshName + '/virtualNode/colorgateway-vn',
        // APPMESH_XDS_ENDPOINT
        'ENABLE_ENVOY_STATS_TAGS': '1',
        'ENABLE_ENVOY_XRAY_TRACING': '1',
        'ENVOY_LOG_LEVEL': 'debug'
      },
      healthCheck: {
        command: ["curl -s http://localhost:9901/server_info | grep state | grep -q LIVE"],
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3
      },
      user: '1337',
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: "colorgatewayenvoy-"
      })
    })
    envoyContainer.addPortMappings(
      { containerPort: 9901 },
      { containerPort: 15000 },
      { containerPort: 15001 }
    )
    envoyContainer.addUlimits({
      hardLimit: 15000,
      softLimit: 15000,
      name: ecs.UlimitName.NOFILE
    })

    var x = colorgatewayTaskDefinition.node.findChild('Resource') as ecs.CfnTaskDefinition;
    x.addPropertyOverride('ProxyConfiguration', {
      Type: 'APPMESH',
      ContainerName: 'envoy',
      ProxyConfigurationProperties: [
        {
          Name: 'IgnoredUID',
          Value: '1337',
        },
        {
          Name: 'ProxyIngressPort',
          Value: '15000',
        },
        {
          Name: 'ProxyEgressPort',
          Value: '15001',
        },
        {
          Name: 'AppPorts',
          Value: '9080'
        },
        {
          Name: 'EgressIgnoredIPs',
          Value: '169.254.170.2,169.254.169.254',
        },
      ],
    });

    //ECS cluster service for gateway
    //using cloud map to connect it with virtual node using virtual gateways nodes DNS 
    //using above task defination 
    const colorgatewayService = new ecs.FargateService(this, 'colorgateway-service', {
      cluster: fgCluster,
      desiredCount: 1,
      taskDefinition: colorgatewayTaskDefinition,
      cloudMapOptions: {
        name: 'colorgateway',
        dnsTtl: cdk.Duration.seconds(10)
      }
    });

    //connecting it to load balancer so we can use this gateway service to call color teller application
    const externalLB = new elbv2.ApplicationLoadBalancer(this, 'external', {
      vpc: vpc,
      internetFacing: true
    });
    const externalListener = externalLB.addListener('PublicListener', {
      port: 80
    });

    externalListener.addTargets('colorgateway', {
      port: 80,
      // pathPattern: "/color*",
      // priority: 4,
      healthCheck: healthCheckDefault,
      targets: [colorgatewayService]
    });


    // Colors Services
    // we have 4 service for for virtual nodes created in app mesh 
    const colorTellers = ["white", "black", "red", "blue",]
    let colorTellersTaskDefinition = new Array()

    //task defination for colorteller application
    //creating container and envoy proxy
    for (var v = 0; v < colorTellers.length; v++) {
      colorTellersTaskDefinition[v] = new ecs.FargateTaskDefinition(this, 'colorteller-' + colorTellers[v] + '-task-definition', {
        taskRole: taskIAMRole
      })
      colorTellersTaskDefinition[v].addContainer('colortellerApp', {
        image: ecs.ContainerImage.fromRegistry('kopi/colorteller'),
        environment: {
          'COLOR': colorTellers[v],
          'SERVER_PORT': '9080'
        },
        logging: new ecs.AwsLogDriver({
          logGroup: logGroup,
          streamPrefix: 'colorteller-' + colorTellers[v] + '-'
        }),
      }).addPortMappings({
        containerPort: 9080
      })

      let thisEnvoy = colorTellersTaskDefinition[v].addContainer('envoy', {
        image: ecs.ContainerImage.fromRegistry('kopi/appmesh:latest'),
        environment: {
          'APPMESH_VIRTUAL_NODE_NAME': 'mesh/' + meshName + '/virtualNode/colorteller-' + colorTellers[v] + '-vn',
          'ENABLE_ENVOY_STATS_TAGS': '1',
          'ENABLE_ENVOY_XRAY_TRACING': '1',
          'ENVOY_LOG_LEVEL': 'debug'
        },
        healthCheck: {
          command: ["curl -s http://localhost:9901/server_info | grep state | grep -q LIVE"],
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          retries: 3
        },
        user: '1337',
        logging: new ecs.AwsLogDriver({
          logGroup: logGroup,
          streamPrefix: "envoy-colorteller-" + colorTellers[v]
        })
      })
      thisEnvoy.addPortMappings(
        { containerPort: 9901 },
        { containerPort: 15000 },
        { containerPort: 15001 }
      )
      thisEnvoy.addUlimits({
        hardLimit: 15000,
        softLimit: 15000,
        name: ecs.UlimitName.NOFILE
      })

      let proxyCfg = colorTellersTaskDefinition[v].node.findChild('Resource') as ecs.CfnTaskDefinition;
      proxyCfg.addPropertyOverride('ProxyConfiguration', {
        Type: 'APPMESH',
        ContainerName: 'envoy',
        ProxyConfigurationProperties: [
          {
            Name: 'IgnoredUID',
            Value: '1337',
          },
          {
            Name: 'ProxyIngressPort',
            Value: '15000',
          },
          {
            Name: 'ProxyEgressPort',
            Value: '15001',
          },
          {
            Name: 'AppPorts',
            Value: '9080'
          },
          {
            Name: 'EgressIgnoredIPs',
            Value: '169.254.170.2,169.254.169.254',
          },
        ],
      });

      //service inside ECS cluster and linking it with respective 4 virtual nodes in app mesh 
      let fgServiceName = (colorTellers[v] == "white") ? "colorteller" : "colorteller-" + colorTellers[v]
      new ecs.FargateService(this, 'colorteller-' + colorTellers[v] + '-service', {
        cluster: fgCluster,
        desiredCount: 1,
        taskDefinition: colorTellersTaskDefinition[v],
        securityGroup: colortellerSecurityGroup,
        cloudMapOptions: {
          name: fgServiceName,
          dnsTtl: cdk.Duration.seconds(10)
        }
      })

    }

    //print out ALB DNS
    new cdk.CfnOutput(this, 'ALBDNS: ', { value: externalLB.loadBalancerDnsName });
  }
}
