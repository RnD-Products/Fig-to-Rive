import sys, re, math
import xml.etree.ElementTree as ET
import os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import flatten_layout as F
d=sys.argv[1]; order=sys.argv[2] if len(sys.argv)>2 else 'A'
root=ET.fromstring(open(d+'/scene.rml').read())
parents={c:p for p in root.iter() for c in p}
num=F.num; fnum=F.fnum
ids=iter(range(1,10000))
def nid(): return '8:%d'%next(ids)
keys=list(root.iter('KeyedObject'))
retarget={}
for dn in [e for e in root.iter('LayoutComponent') if e.get('name')=='Drag node']:
    ag=next(c for c in dn if c.tag=='LayoutComponent' and c.get('name')=='Agency')
    st=style=F.style_of(ag); left,top=fnum(st.get('positionLeft')),fnum(st.get('positionTop'))
    w,h=fnum(ag.get('width')),fnum(ag.get('height'))
    shadow_box=next(c for c in ag if c.tag=='LayoutComponent' and 'Shadow' in (c.get('name') or '') and c.get('name')!='Inner Shadow')
    frame=next(c for c in shadow_box if c.tag=='LayoutComponent')
    inner=next(c for c in frame if c.tag=='LayoutComponent' and c.get('name')=='Inner Shadow')
    cur=next(c for c in ag if c.tag=='LayoutComponent' and 'cursor' in (c.get('name') or ''))
    frame_node=next(c for c in frame if c.tag=='Node')
    text=next(frame_node.iter('Text'))
    fst=F.style_of(frame); rad=fnum(fst.get('cornerRadiusTL'))
    shadow=[c for c in shadow_box if c.tag=='Fill']; fills=[c for c in frame if c.tag=='Fill']; strokes=[c for c in frame if c.tag=='Stroke']; inn=[c for c in inner if c.tag=='Fill']
    pill=ET.Element('Shape',{'x':'0','y':'0','name':'%s pill'%ag.get('name'),'id':nid()})
    ET.SubElement(pill,'Rectangle',{'width':num(w),'height':num(h),'cornerRadiusTL':num(rad),'cornerRadiusTR':num(rad),'cornerRadiusBL':num(rad),'cornerRadiusBR':num(rad),'name':'Path'})
    seq={'A':inn+strokes+fills+shadow,'B':shadow+fills+inn+strokes,'C':inn+strokes+shadow+fills}[order]
    for f in seq:
        for g in f.iter():
            if g.tag in('RadialGradient','LinearGradient'):
                for k,o in(('startX',w/2),('endX',w/2),('startY',h/2),('endY',h/2)):
                    if g.get(k) is not None: g.set(k,num(fnum(g.get(k))-o))
        pill.append(f)
    text.set('x','0'); text.set('y','0')
    # cursor
    cst=F.style_of(cur); cl,ct=fnum(cst.get('positionLeft')),fnum(cst.get('positionTop')); cw,ch=fnum(cur.get('width')),fnum(cur.get('height'))
    cnode=ET.Element('Node',{'x':num(cl+cw/2-w/2),'y':num(ct+ch/2-h/2),'name':'Cursor','id':nid()})
    for sh in cur.iter('Shape'):
        sh.set('x',num(fnum(sh.get('x'))-cw/2)); sh.set('y',num(fnum(sh.get('y'))-ch/2)); cnode.append(sh)
    pnode=ET.Element('Node',{'x':num(left+w/2),'y':num(top+h/2),'name':'%s (Free)'%ag.get('name'),'id':nid()})
    pnode.append(cnode); pnode.append(text); pnode.append(pill)   # first child on top
    newd=ET.Element('Node',{'name':'Drag node','id':dn.get('id')}); newd.append(pnode)
    p=parents[dn]; p.insert(list(p).index(dn),newd); p.remove(dn)
    # keys
    old_ag,old_cur,old_style=ag.get('id'),cur.get('id'),st.get('id')
    for ko in keys:
        oid=ko.get('objectId')
        if oid==old_ag: ko.set('objectId',pnode.get('id'))
        elif oid==old_cur: ko.set('objectId',cnode.get('id'))
        elif oid==old_style:
            ko.set('objectId',pnode.get('id'))
            for kp in ko:
                if kp.get('property')=='positionLeft': kp.set('property','x'); [k.set('value',num(fnum(k.get('value'))+w/2)) for k in kp if k.tag=='KeyFrameDouble']
                elif kp.get('property')=='positionTop': kp.set('property','y'); [k.set('value',num(fnum(k.get('value'))+h/2)) for k in kp if k.tag=='KeyFrameDouble']
    retarget[old_ag]=pill.get('id')
for el in root.iter():
    if el.tag.startswith('StateMachineListener') and el.get('targetId') in retarget: el.set('targetId',retarget[el.get('targetId')])
open(d+'/scene.rml','w').write(ET.tostring(root,encoding='unicode'))
print('converted',len(retarget))
