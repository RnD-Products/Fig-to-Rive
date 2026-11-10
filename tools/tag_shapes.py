import sys
import xml.etree.ElementTree as ET
import os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import flatten_layout as F
d=sys.argv[1]; root=ET.fromstring(open(d+'/scene.rml').read())
parents={c:p for p in root.iter() for c in p}
num,fnum=F.num,F.fnum
cnt=iter(range(1,10000)); nid=lambda:'7:%d'%next(cnt)
keys=list(root.iter('KeyedObject')); retarget={}
def recenter(f,w,h):
    for g in f.iter():
        if g.tag in('RadialGradient','LinearGradient'):
            for k,o in(('startX',w/2),('endX',w/2),('startY',h/2),('endY',h/2)):
                if g.get(k) is not None: g.set(k,num(fnum(g.get(k))-o))
for T in [e for e in root.iter('LayoutComponent') if e.get('name')=='Tag Shadow']:
    tag=next(c for c in T if c.tag=='LayoutComponent' and c.get('name')=='Tag')
    sh=next(c for c in T if c.tag=='LayoutComponent' and c.get('name')=='Shadow')
    inner=next(c for c in tag if c.tag=='LayoutComponent' and c.get('name')=='Inner Shadow')
    icon=next(c for c in tag if c.tag=='LayoutComponent' and (c.get('name') or '').startswith('icon'))
    flat=next(c for c in tag if c.tag=='Node'); text=next(flat.iter('Text'))
    w,h=fnum(tag.get('width')),fnum(tag.get('height')); tst=F.style_of(T); left,top=fnum(tst.get('positionLeft')),fnum(tst.get('positionTop'))
    rad=fnum(F.style_of(tag).get('cornerRadiusTL'))
    pill=ET.Element('Shape',{'x':'0','y':'0','name':'Tag pill','id':nid()})
    ET.SubElement(pill,'Rectangle',{'width':num(w),'height':num(h),'cornerRadiusTL':num(rad),'cornerRadiusTR':num(rad),'cornerRadiusBL':num(rad),'cornerRadiusBR':num(rad),'name':'Path'})
    for f in [c for c in tag if c.tag in('Fill','Stroke')]+[c for c in inner if c.tag=='Fill']:
        recenter(f,w,h); pill.append(f)
    sw,shh=fnum(sh.get('width')),fnum(sh.get('height')); sst=F.style_of(sh)
    shd=ET.Element('Shape',{'x':num(fnum(sst.get('positionLeft'))+sw/2-w/2),'y':num(fnum(sst.get('positionTop'))+shh/2-h/2),'name':'Tag shadow','id':nid()})
    srad=fnum(sst.get('cornerRadiusTL'))
    ET.SubElement(shd,'Rectangle',{'width':num(sw),'height':num(shh),'cornerRadiusTL':num(srad),'cornerRadiusTR':num(srad),'cornerRadiusBL':num(srad),'cornerRadiusBR':num(srad),'name':'Path'})
    for f in [c for c in sh if c.tag=='Fill']: recenter(f,sw,shh); shd.append(f)
    ist=F.style_of(icon); iw,ih=fnum(icon.get('width')),fnum(icon.get('height'))
    inode=ET.Element('Node',{'x':num(fnum(ist.get('positionLeft'))+iw/2-w/2),'y':num(fnum(ist.get('positionTop'))+ih/2-h/2),'name':'Tag icon','id':nid()})
    for s_ in icon.iter('Shape'):
        s_.set('x',num(fnum(s_.get('x'))-iw/2)); s_.set('y',num(fnum(s_.get('y'))-ih/2)); inode.append(s_)
    text.set('x',num(fnum(text.get('x'))-w/2)); text.set('y',num(fnum(text.get('y'))-h/2))
    for c in list(text):
        if c.tag=='LayoutParticipant': text.remove(c)
    pnode=ET.Element('Node',{'x':num(left+w/2),'y':num(top+h/2),'name':'Tag (Free)','id':nid()})
    for e in (text,inode,pill,shd): pnode.append(e)
    p=parents[T]; p.insert(list(p).index(T),pnode); p.remove(T)
    for ko in keys:
        oid=ko.get('objectId')
        if oid==T.get('id'): ko.set('objectId',pnode.get('id'))
        elif oid==tst.get('id'):
            ko.set('objectId',pnode.get('id'))
            for kp in ko:
                if kp.get('property')=='positionLeft': kp.set('property','x'); [k.set('value',num(fnum(k.get('value'))+w/2)) for k in kp if k.tag=='KeyFrameDouble']
                elif kp.get('property')=='positionTop': kp.set('property','y'); [k.set('value',num(fnum(k.get('value'))+h/2)) for k in kp if k.tag=='KeyFrameDouble']
    retarget[T.get('id')]=pill.get('id')
for el in root.iter():
    if el.tag.startswith('StateMachineListener') and el.get('targetId') in retarget: el.set('targetId',retarget[el.get('targetId')])
open(d+'/scene.rml','w').write(ET.tostring(root,encoding='unicode')); print('tags',len(retarget))
